import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { Server } from 'node:http';
import { TestReceiverModule } from './../src/test-receiver.module.js';

describe('TestReceiverController (e2e)', () => {
  let app: INestApplication<Server>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [TestReceiverModule],
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
      .send({ id: 'event-1', type: 'order.created', payload: {} })
      .expect(204);
  });

  afterEach(async () => {
    await app.close();
  });
});
