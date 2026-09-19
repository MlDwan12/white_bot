import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Остаётся без входа намеренно. Проверка живости нужна балансировщику и
 * оркестратору, у которых нет и не может быть пароля админа, а наружу она
 * отдаёт только `{status:'ok'}` — знать об этом постороннему нечего.
 *
 * Право `system_health` из `PLAN.md` относится к будущей диагностике
 * (глубина очереди, зависшие доставки): вот она уже рассказывает о системе
 * достаточно, чтобы её закрыть.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async check() {
    await this.prisma.$queryRaw`SELECT 1`;
    return { status: 'ok' };
  }
}
