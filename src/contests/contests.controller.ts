import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ContestsService } from './contests.service';
import {
  AddParticipantsDto,
  CreateContestDto,
  SetPrizesDto,
  SetWinnerDto,
} from './dto/contest.dto';

/**
 * Guard'ов здесь пока нет: RBAC заведён на Шаг 9, как и у остальных
 * контроллеров проекта. Право `contests.manage` навесится вместе с ними.
 */
@Controller('contests')
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
  draw(@Param('id', ParseUUIDPipe) id: string) {
    return this.contests.draw(id);
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
  ) {
    await this.contests.overrideWinner(prizeId, dto.participantId, dto.note);
    return { ok: true };
  }
}
