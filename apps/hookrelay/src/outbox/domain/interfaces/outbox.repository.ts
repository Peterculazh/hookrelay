import type { TransactionContext } from '@app/database';

export const OUTBOX_REPOSITORY = Symbol('OUTBOX_REPOSITORY');

export type NewOutboxEntry = {
  id: string;
  eventId: string;
};

export type OutboxEntry = NewOutboxEntry & {
  createdAt: Date;
  publishedAt: Date | null;
};

export interface OutboxRepository {
  save(entry: NewOutboxEntry, tx: TransactionContext): Promise<OutboxEntry>;
}
