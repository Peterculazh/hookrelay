import { Test, TestingModule } from '@nestjs/testing';
import { TestReceiverController } from './test-receiver.controller.js';
import { TestReceiverService } from './test-receiver.service.js';

describe('TestReceiverController', () => {
  let testReceiverController: TestReceiverController;
  let testReceiverService: TestReceiverService;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [TestReceiverController],
      providers: [TestReceiverService],
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
    it('accepts a webhook event', () => {
      const event = { id: 'event-1', type: 'order.created' };
      const receiveWebhook = vi
        .spyOn(testReceiverService, 'receiveWebhook')
        .mockImplementation(() => undefined);

      expect(testReceiverController.receiveWebhook(event)).toBeUndefined();
      expect(receiveWebhook).toHaveBeenCalledWith(event);
    });
  });
});
