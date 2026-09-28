import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { Server } from 'node:http';
import { TestReceiverController } from '../src/test-receiver.controller.js';
import { TestReceiverService } from '../src/test-receiver.service.js';

describe('TestReceiverController (e2e)', () => {
  let app: INestApplication<Server>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
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

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('/ (GET)', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect('Hello World!');
  });

  it('/webhooks (POST)', () => {
    return request(app.getHttpServer())
      .post('/webhooks')
      .send({
        id: '87b31430-01b0-4443-995d-e9a780e7a142',
        type: 'order.created',
        payload: {},
      })
      .expect(204);
  });

  afterEach(async () => {
    await app.close();
  });
});
