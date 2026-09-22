import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { Server } from 'node:http';
import { DatabaseService } from '../../../libs/database/src/database.service.js';
import { AppModule } from './../src/app.module.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('AppController (e2e)', () => {
  let app: INestApplication<Server>;
  let checkConnection: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    checkConnection = vi.fn().mockResolvedValue(undefined);
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DatabaseService)
      .useValue({ checkConnection })
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('/ (GET)', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect('Hello World!');
  });

  it('/health/live (GET)', () => {
    return request(app.getHttpServer())
      .get('/health/live')
      .expect(200)
      .expect('')
      .expect(() => expect(checkConnection).not.toHaveBeenCalled());
  });

  it('/health/ready (GET) returns 200 when PostgreSQL responds', () => {
    return request(app.getHttpServer())
      .get('/health/ready')
      .expect(200)
      .expect('')
      .expect(() => expect(checkConnection).toHaveBeenCalledWith(1_000));
  });

  it('/health/ready (GET) returns 503 when PostgreSQL fails', () => {
    checkConnection.mockRejectedValue(new Error('PostgreSQL unavailable'));

    return request(app.getHttpServer()).get('/health/ready').expect(503);
  });

  afterEach(async () => {
    await app.close();
  });
});
