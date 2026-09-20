import { z } from 'zod';

export const saveEventSchema = z.object({
  type: z.string(),
  payload: z.object({
    orderId: z.string(),
    amount: z.number(),
    currency: z.string(),
  }),
});

export type SaveEventDto = z.infer<typeof saveEventSchema>;
