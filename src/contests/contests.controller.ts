import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AdminAuthGuard } from '../auth/admin-auth.guard';
import { CurrentAdmin } from '../auth/current-admin.decorator';
import type { AdminUser } from '../generated/prisma/client';
import { CsrfGuard } from '../auth/csrf.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { ContestsService } from './contests.service';
import {
  AddParticipantsDto,
  CreateContestDto,
  SetPrizesDto,
  SetWinnerDto,
} from './dto/contest.dto';

/**
 * Админская половина конкурсов. Участники сюда не ходят — у них свой вход
 * через мини-приложение, с проверкой подписи запуска вместо логина.
 */
@Controller('contests')
@UseGuards(AdminAuthGuard, CsrfGuard)
@RequirePermissions('contests_manage')
export class ContestsController {
  constructor(private readonly contests: ContestsService) {}

  @Post()
  create(@Body() dto: CreateContestDto) {
    return this.contests.createContest(dto);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.contests.getContest(id);
  }

  @Post(':id/open')
  open(@Param('id', ParseUUIDPipe) id: string) {
    return this.contests.openContest(id);
  }

  @Post(':id/prizes')
  async setPrizes(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetPrizesDto,
  ) {
    await this.contests.setPrizes(id, dto.prizes);
    return { ok: true };
  }

  @Post(':id/participants')
  addParticipants(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddParticipantsDto,
  ) {
    return this.contests.addParticipantsFromText(id, dto.text);
  }

  @Post(':id/draw')
  draw(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AdminUser,
  ) {
    // Теперь в журнале розыгрыша есть, кто его провёл: до появления входа
    // писать туда было некого, и поле оставалось пустым.
    return this.contests.draw(id, admin.id);
  }

  /** «Подкрутка» до розыгрыша: место закрепляется за участником. */
  @Post('prizes/:prizeId/force-winner')
  async forceWinner(
    @Param('prizeId', ParseUUIDPipe) prizeId: string,
    @Body() dto: SetWinnerDto,
  ) {
    await this.contests.forceWinner(prizeId, dto.participantId);
    return { ok: true };
  }

  /** Замена победителя после розыгрыша — отдельной записью в журнале. */
  @Post('prizes/:prizeId/override-winner')
  async overrideWinner(
    @Param('prizeId', ParseUUIDPipe) prizeId: string,
    @Body() dto: SetWinnerDto,
    @CurrentAdmin() admin: AdminUser,
  ) {
    await this.contests.overrideWinner(
      prizeId,
      dto.participantId,
      dto.note,
      admin.id,
    );
    return { ok: true };
  }
}
