import { Test, TestingModule } from '@nestjs/testing';
import { ServiceUnavailableException } from '@nestjs/common';
import { DatabaseService } from '../../../libs/database/src/database.service.js';
import { AppController } from './app.controller.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('AppController', () => {
  let appController: AppController;
  let checkConnection: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    checkConnection = vi.fn();

    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        {
          provide: DatabaseService,
          useValue: { checkConnection },
        },
      ],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('health', () => {
    it('reports the process as live without checking PostgreSQL', () => {
      expect(appController.healthLive()).toBeUndefined();
      expect(checkConnection).not.toHaveBeenCalled();
    });

    it('reports ready when PostgreSQL responds', async () => {
      checkConnection.mockResolvedValue(undefined);

      await expect(appController.healthReady()).resolves.toBeUndefined();
      expect(checkConnection).toHaveBeenCalledWith(1_000);
    });

    it('reports unavailable when the PostgreSQL check fails', async () => {
      checkConnection.mockRejectedValue(new Error('PostgreSQL unavailable'));

      await expect(appController.healthReady()).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });
  });
});
