import request from 'supertest';
import { AuditStore, hashAuditEntry } from '../src/audit';
import { createApp } from '../src/app';
import { EscrowStore } from '../src/store';

describe('tamper-evident audit history', () => {
  it('records create, deposit, and both releases with before and after state', async () => {
    const store = new EscrowStore();
    const app = createApp(store);
    const created = await request(app)
      .post('/api/v1/contracts')
      .set('x-request-id', 'audit-create-001')
      .send({ client: 'GC', freelancer: 'GF', milestones: [{ amount: 10 }, { amount: 20 }] })
      .expect(201);
    const id = created.body.id;
    await request(app).post(`/api/v1/contracts/${id}/deposit`).send({ amount: 30 }).expect(200);
    await request(app).post(`/api/v1/contracts/${id}/milestones/0/release`).expect(200);
    await request(app).post(`/api/v1/contracts/${id}/milestones/1/release`).expect(200);

    const history = await request(app).get(`/api/v1/contracts/${id}/history`).expect(200);
    expect(history.body.data).toHaveLength(4);
    expect(history.body.data.map((entry: { action: string }) => entry.action)).toEqual([
      'create', 'deposit', 'release', 'release',
    ]);
    expect(history.body.data.map((entry: { before: object; after: object }) => [entry.before, entry.after])).toEqual([
      [{ status: null, fundedAmount: 0, releasedAmount: 0 }, { status: 'Created', fundedAmount: 0, releasedAmount: 0 }],
      [{ status: 'Created', fundedAmount: 0, releasedAmount: 0 }, { status: 'Funded', fundedAmount: 30, releasedAmount: 0 }],
      [{ status: 'Funded', fundedAmount: 30, releasedAmount: 0 }, { status: 'Funded', fundedAmount: 30, releasedAmount: 10 }],
      [{ status: 'Funded', fundedAmount: 30, releasedAmount: 10 }, { status: 'Completed', fundedAmount: 30, releasedAmount: 30 }],
    ]);
    expect(history.body.data[0].requestId).toBe('audit-create-001');
  });

  it('does not record failed releases and paginates history by global cursor', async () => {
    const store = new EscrowStore();
    const app = createApp(store);
    const created = await request(app)
      .post('/api/v1/contracts')
      .send({ client: 'GC', freelancer: 'GF', milestones: [{ amount: 10 }, { amount: 20 }] });
    const id = created.body.id;
    await request(app).post(`/api/v1/contracts/${id}/deposit`).send({ amount: 10 });
    await request(app).post(`/api/v1/contracts/${id}/milestones/1/release`).expect(409);
    const first = await request(app).get(`/api/v1/contracts/${id}/history?limit=1`).expect(200);
    expect(first.body.data).toHaveLength(1);
    expect(first.body.nextCursor).toBe(first.body.data[0].seq);
    const second = await request(app)
      .get(`/api/v1/contracts/${id}/history?limit=2&cursor=${first.body.nextCursor}`)
      .expect(200);
    expect(second.body.data.map((entry: { action: string }) => entry.action)).toEqual(['deposit']);
    expect(second.body.nextCursor).toBeNull();
    expect((await request(app).get(`/api/v1/contracts/${id}/history`)).body.data).toHaveLength(2);
  });

  it('records resolution split details and uses raisedBy as the dispute actor', async () => {
    const store = new EscrowStore();
    const app = createApp(store);
    const created = await request(app)
      .post('/api/v1/contracts')
      .send({ client: 'GC', freelancer: 'GF', milestones: [{ amount: 100 }] });
    const id = created.body.id;
    await request(app).post(`/api/v1/contracts/${id}/deposit`).send({ amount: 80 });
    await request(app).post(`/api/v1/contracts/${id}/dispute`).send({ raisedBy: 'GF', reason: 'review' });
    await request(app).post(`/api/v1/contracts/${id}/resolve`).send({ freelancerBps: 2500 });
    const { body } = await request(app).get(`/api/v1/contracts/${id}/history`);
    expect(body.data[2].actor).toBe('GF');
    expect(body.data[3].details).toEqual({ freelancerBps: 2500, toFreelancer: 20, toClient: 60 });
  });

  it('detects tampering and remains verifiable after oldest-entry eviction', async () => {
    const audit = new AuditStore(2);
    const store = new EscrowStore(audit);
    const app = createApp(store);
    const created = await request(app)
      .post('/api/v1/contracts')
      .send({ client: 'GC', freelancer: 'GF', milestones: [{ amount: 10 }] });
    const id = created.body.id;
    await request(app).post(`/api/v1/contracts/${id}/deposit`).send({ amount: 1 });
    await request(app).post(`/api/v1/contracts/${id}/deposit`).send({ amount: 1 });
    expect((await request(app).get('/api/v1/audit/verify')).body).toEqual({
      valid: true,
      entries: 2,
      truncatedBeforeSeq: 1,
    });
    audit.tamperEntryForTest(2, { action: 'cancel' });
    expect((await request(app).get('/api/v1/audit/verify')).body).toEqual({
      valid: false,
      entries: 2,
      brokenAt: 2,
      truncatedBeforeSeq: 1,
    });
  });

  it('detects deleted and reordered entries at the first broken sequence', () => {
    const deleted = new AuditStore();
    deleted.append({
      contractId: 1, action: 'create', actor: null, requestId: null, at: '2025-01-01T00:00:00.000Z',
      before: { status: null, fundedAmount: 0, releasedAmount: 0 },
      after: { status: 'Created', fundedAmount: 0, releasedAmount: 0 }, details: {},
    });
    deleted.append({
      contractId: 1, action: 'cancel', actor: null, requestId: null, at: '2025-01-01T00:00:01.000Z',
      before: { status: 'Created', fundedAmount: 0, releasedAmount: 0 },
      after: { status: 'Cancelled', fundedAmount: 0, releasedAmount: 0 }, details: {},
    });
    deleted.deleteEntryForTest(2);
    expect(deleted.verify()).toMatchObject({ valid: false, brokenAt: 2 });

    const reordered = new AuditStore();
    for (const action of ['create', 'deposit'] as const) {
      reordered.append({
        contractId: 1, action, actor: null, requestId: null, at: '2025-01-01T00:00:00.000Z',
        before: { status: 'Created', fundedAmount: 0, releasedAmount: 0 },
        after: { status: 'Created', fundedAmount: 0, releasedAmount: 0 }, details: {},
      });
    }
    reordered.tamperEntryForTest(1, { seq: 2 });
    expect(reordered.verify()).toMatchObject({ valid: false, brokenAt: 1 });
  });

  it('matches the committed SHA-256 hash vector', () => {
    const entry = {
      seq: 1,
      contractId: 7,
      action: 'create' as const,
      actor: null,
      requestId: null,
      at: '2025-01-02T03:04:05.000Z',
      before: { status: null, fundedAmount: 0, releasedAmount: 0 },
      after: { status: 'Created' as const, fundedAmount: 0, releasedAmount: 0 },
      details: { totalAmount: 30 },
      prevHash: '0'.repeat(64),
    };
    expect(hashAuditEntry(entry)).toBe('babe9afca55d98eba440ba35822121a69b0c2b2446ff9f49883f002bf1d14688');
  });
});