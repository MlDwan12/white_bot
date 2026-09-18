import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

// Requires `docker compose up -d` (Postgres/Redis) and a valid `.env` first —
// AppModule imports PrismaModule globally, which connects on init, so even
// this trivial route needs live infra. See PLAN.md, Шаг 1.
describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    // Required now that the app owns a BullMQ worker and Redis connections:
    // leaving them open keeps the Node process alive and the test run never
    // finishes. It also exercises the shutdown path on every run.
    await app.close();
  });

  it('/ (GET)', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect({ success: true, data: 'Hello World!' });
  });
});
