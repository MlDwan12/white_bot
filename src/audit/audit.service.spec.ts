import { PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import {
  AUDIT_RETENTION_DAYS,
  AuditService,
  postSnippet,
} from './audit.service';
import {
  requestContextMiddleware,
  runAsAdmin,
  setCurrentAdmin,
} from './request-context';

function setup() {
  const prisma = {
    auditLog: {
      create: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 7 }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    // Очистка и её след — одной транзакцией.
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
    Promise.resolve(fn(prisma)),
  );
  const logger = { setContext: jest.fn(), error: jest.fn() };
  const service = new AuditService(
    prisma as unknown as PrismaService,
    logger as unknown as PinoLogger,
  );
  return { service, prisma, logger };
}

const written = (prisma: ReturnType<typeof setup>['prisma']) =>
  (prisma.auditLog.create.mock.calls as unknown[][]).map(
    (call) => (call[0] as { data: Record<string, unknown> }).data,
  );

describe('AuditService.record', () => {
  it('без запроса и без явного автора — «автоматика»', async () => {
    // Сверка по таймеру: розыгрыш по дате, авто-открытие.
    const { service, prisma } = setup();

    await service.record({ action: 'contest.draw', summary: 'x' });

    expect(written(prisma)[0]).toMatchObject({
      actorType: 'system',
      actorId: null,
    });
  });

  it('в HTTP-запросе автор — вошедший админ, без параметра', async () => {
    const { service, prisma } = setup();

    await new Promise<void>((resolve, reject) => {
      requestContextMiddleware({} as never, {} as never, () => {
        // Так делает AdminAuthGuard, опознав админа.
        setCurrentAdmin('admin-1');
        service
          .record({ action: 'post.send', summary: 'x' })
          .then(resolve, reject);
      });
    });

    expect(written(prisma)[0]).toMatchObject({
      actorType: 'admin',
      actorId: 'admin-1',
    });
  });

  it('вне запроса от имени админа — для подтверждения группы из чата бота', async () => {
    const { service, prisma } = setup();

    await runAsAdmin('admin-2', () =>
      service.record({ action: 'group.confirm', summary: 'x' }),
    );

    expect(written(prisma)[0]).toMatchObject({ actorId: 'admin-2' });
  });

  it('явный автор «бот» — бот, даже внутри запроса', async () => {
    const { service, prisma } = setup();

    await runAsAdmin('admin-3', () =>
      service.record({ actor: 'bot', action: 'group.bot_added', summary: 'x' }),
    );

    expect(written(prisma)[0]).toMatchObject({
      actorType: 'bot',
      actorId: null,
    });
  });

  it('сбой записи не ломает действие — только лог (вариант А)', async () => {
    const { service, prisma, logger } = setup();
    prisma.auditLog.create.mockRejectedValue(new Error('db down'));

    await expect(
      service.record({ action: 'contest.draw', summary: 'x' }),
    ).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('AuditService.list', () => {
  it('«показать ещё» — курсором (время, id): ни потери записей одной миллисекунды, ни обрыва', async () => {
    const { service, prisma } = setup();
    const at = new Date('2026-10-27T10:00:00Z');

    await service.list({ limit: 20, beforeAt: at, beforeId: 'row-9' });

    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { OR: [{ at: { lt: at } }, { at, id: { lt: 'row-9' } }] },
        orderBy: [{ at: 'desc' }, { id: 'desc' }],
        take: 20,
      }),
    );
  });
});

describe('AuditService — очистка', () => {
  it('ручная очистка оставляет след, кто и сколько удалил', async () => {
    // Иначе очисткой можно было бы незаметно стереть чужие действия.
    const { service, prisma } = setup();

    await expect(service.clear('admin-1')).resolves.toBe(7);

    // Следы прошлых очисток ручная очистка не трогает — иначе второй
    // очисткой стирался бы след первой.
    expect(prisma.auditLog.deleteMany).toHaveBeenCalledWith({
      where: { action: { not: 'audit.clear' } },
    });
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(written(prisma)[0]).toMatchObject({
      actorId: 'admin-1',
      action: 'audit.clear',
    });
  });

  it('очистка «до даты» удаляет только более старые записи', async () => {
    const { service, prisma } = setup();
    const before = new Date('2026-10-01T00:00:00Z');

    await service.clear('admin-1', before);

    expect(prisma.auditLog.deleteMany).toHaveBeenCalledWith({
      where: { action: { not: 'audit.clear' }, at: { lt: before } },
    });
  });

  it('автоочистка удаляет старше срока хранения', async () => {
    const { service, prisma } = setup();
    const now = new Date('2026-10-31T00:00:00Z');

    await service.purgeExpired(now);

    const { where } = (
      prisma.auditLog.deleteMany.mock.calls as unknown[][]
    )[0][0] as {
      where: { at: { lt: Date } };
    };
    expect(now.getTime() - where.at.lt.getTime()).toBe(
      AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
  });
});

describe('postSnippet', () => {
  it('режет по символам — эмодзи на границе не превращается в «�»', () => {
    const text = `${'а'.repeat(48)}🎉🎉 и дальше`;

    const snippet = postSnippet(text);

    expect(snippet).toBe(`${'а'.repeat(48)}🎉…`);
    expect(snippet).not.toMatch(/\uFFFD/);
  });

  it('пустой текст — пустая строка, не исключение', () => {
    expect(postSnippet(undefined)).toBe('');
  });
});
