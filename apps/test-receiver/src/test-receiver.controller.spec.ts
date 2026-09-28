import { Test, TestingModule } from '@nestjs/testing';
import { TestReceiverController } from './test-receiver.controller.js';
import { TestReceiverService } from './test-receiver.service.js';

describe('TestReceiverController', () => {
  let testReceiverController: TestReceiverController;
  let testReceiverService: TestReceiverService;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [TestReceiverController],
      providers: [
        {
          provide: TestReceiverService,
          useValue: {
            getHello: () => 'Hello World!',
            receiveWebhook: vi.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    testReceiverController = app.get<TestReceiverController>(
      TestReceiverController,
    );
    testReceiverService = app.get<TestReceiverService>(TestReceiverService);
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(testReceiverController.getHello()).toBe('Hello World!');
    });
  });

  describe('webhooks', () => {
    it('waits for persistence before acknowledging', async () => {
      let commit!: () => void;
      vi.spyOn(testReceiverService, 'receiveWebhook').mockReturnValue(
        new Promise<void>((resolve) => {
          commit = resolve;
        }),
      );
      let finished = false;
      const response = testReceiverController.receiveWebhook({}).then(() => {
        finished = true;
      });
      await Promise.resolve();
      expect(finished).toBe(false);
      commit();
      await response;
      expect(finished).toBe(true);
    });

    it('propagates persistence failures instead of acknowledging', async () => {
      vi.spyOn(testReceiverService, 'receiveWebhook').mockRejectedValue(
        new Error('commit failed'),
      );
      await expect(testReceiverController.receiveWebhook({})).rejects.toThrow(
        'commit failed',
      );
    });

    it('accepts a webhook event', async () => {
      const event = { id: 'event-1', type: 'order.created' };
      const receiveWebhook = vi
        .spyOn(testReceiverService, 'receiveWebhook')
        .mockResolvedValue(undefined);

      await expect(
        testReceiverController.receiveWebhook(event),
      ).resolves.toBeUndefined();
      expect(receiveWebhook).toHaveBeenCalledWith(event);
    });
  });
});
