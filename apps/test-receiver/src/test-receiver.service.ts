import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { DatabaseService, schema } from '@app/database';
import { z } from 'zod';

const webhookSchema = z.object({
  id: z.uuid(),
  type: z.string().min(1).max(255),
  payload: z.json(),
});

@Injectable()
export class TestReceiverService {
  private readonly logger = new Logger(TestReceiverService.name);

  constructor(private readonly database: DatabaseService) {}

  getHello(): string {
    return 'Hello World!';
  }

  async receiveWebhook(input: unknown): Promise<void> {
    const parsed = webhookSchema.safeParse(input);
    if (!parsed.success) {
      throw new BadRequestException(
        'Expected a UUID id, nonempty type, and JSON payload',
      );
    }
    const event = parsed.data;
    const applied = await this.database.transaction(async (transaction) => {
      // The unique key arbitrates concurrent duplicates. Never SELECT then INSERT.
      const inserted = await transaction
        .insert(schema.receivedEvents)
        .values({ eventId: event.id })
        .onConflictDoNothing({ target: schema.receivedEvents.eventId })
        .returning({ eventId: schema.receivedEvents.eventId });
      if (inserted.length === 0) return false;

      await transaction.insert(schema.receiverEffects).values({
        eventId: event.id,
        type: event.type,
        payload: event.payload,
      });
      return true;
    });
    // Only report success after the marker and effect have committed together.
    this.logger.log({
      action: applied ? 'receiver.applied' : 'receiver.duplicate',
      eventId: event.id,
    });
  }
}
