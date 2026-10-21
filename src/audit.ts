import { createHash } from 'node:crypto';
import type { ContractStatus } from './store';

export type AuditAction = 'create' | 'deposit' | 'release' | 'dispute' | 'resolve' | 'cancel' | 'rate';

export interface AuditState {
  status: ContractStatus | null;
  fundedAmount: number | string;
  releasedAmount: number | string;
}

export interface AuditContext {
  actor?: string | null;
  requestId?: string | null;
}

export interface AuditEntry {
  seq: number;
  contractId: number;
  action: AuditAction;
  actor: string | null;
  requestId: string | null;
  at: string;
  before: AuditState;
  after: AuditState;
  details: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

const GENESIS_HASH = '0'.repeat(64);
export const MAX_AUDIT_ENTRIES = 100_000;

function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJSON(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function hashAuditEntry(entry: Omit<AuditEntry, 'hash'>): string {
  return createHash('sha256').update(entry.prevHash + canonicalJSON(entry)).digest('hex');
}

export class AuditStore {
  private readonly entries: AuditEntry[] = [];
  private lastSeq = 0;
  private lastHash = GENESIS_HASH;
  private truncatedSeq = 0;
  private truncatedHash = GENESIS_HASH;

  constructor(private readonly maxEntries = MAX_AUDIT_ENTRIES) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_AUDIT_ENTRIES) {
      throw new RangeError(`maxEntries must be an integer between 1 and ${MAX_AUDIT_ENTRIES}`);
    }
  }

  get truncatedBeforeSeq(): number {
    return this.truncatedSeq;
  }

  append(input: Omit<AuditEntry, 'seq' | 'prevHash' | 'hash'>): AuditEntry {
    const previous = this.entries[this.entries.length - 1];
    const prevHash = previous?.hash ?? this.lastHash;
    const unsigned = { ...input, seq: this.lastSeq + 1, prevHash };
    const entry: AuditEntry = { ...unsigned, hash: hashAuditEntry(unsigned) };
    this.entries.push(entry);
    this.lastSeq = entry.seq;
    this.lastHash = entry.hash;
    if (this.entries.length > this.maxEntries) {
      const removed = this.entries.shift();
      if (removed) {
        this.truncatedSeq = removed.seq;
        this.truncatedHash = removed.hash;
      }
    }
    return { ...entry, before: { ...entry.before }, after: { ...entry.after }, details: { ...entry.details } };
  }

  history(contractId: number, limit: number, cursor?: number): { data: AuditEntry[]; nextCursor: number | null } {
    const matching = this.entries.filter((entry) => entry.contractId === contractId && (cursor === undefined || entry.seq > cursor));
    const page = matching.slice(0, limit);
    return {
      data: page.map((entry) => ({ ...entry, before: { ...entry.before }, after: { ...entry.after }, details: { ...entry.details } })),
      nextCursor: matching.length > page.length && page.length > 0 ? page[page.length - 1].seq : null,
    };
  }

  verify(): { valid: boolean; entries: number; brokenAt?: number; truncatedBeforeSeq: number } {
    let previousHash = this.truncatedHash;
    let expectedSeq = this.truncatedSeq + 1;
    for (const entry of this.entries) {
      const { hash, ...unsigned } = entry;
      if (
        entry.seq !== expectedSeq ||
        (previousHash !== undefined && entry.prevHash !== previousHash) ||
        hashAuditEntry(unsigned) !== hash
      ) {
        return { valid: false, entries: this.entries.length, brokenAt: expectedSeq, truncatedBeforeSeq: this.truncatedSeq };
      }
      previousHash = entry.hash;
      expectedSeq += 1;
    }
    if (expectedSeq <= this.lastSeq || previousHash !== this.lastHash) {
      return { valid: false, entries: this.entries.length, brokenAt: expectedSeq, truncatedBeforeSeq: this.truncatedSeq };
    }
    return { valid: true, entries: this.entries.length, truncatedBeforeSeq: this.truncatedSeq };
  }

  tamperEntryForTest(seq: number, changes: Partial<AuditEntry>): void {
    const entry = this.entries.find((candidate) => candidate.seq === seq);
    if (!entry) throw new RangeError(`Audit entry ${seq} is not retained`);
    Object.assign(entry, changes);
  }

  deleteEntryForTest(seq: number): void {
    const index = this.entries.findIndex((candidate) => candidate.seq === seq);
    if (index < 0) throw new RangeError(`Audit entry ${seq} is not retained`);
    this.entries.splice(index, 1);
  }
}