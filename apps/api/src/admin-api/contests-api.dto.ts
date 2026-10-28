import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Дата из `<input type="datetime-local">` — «настенное» время без пояса.
 * Читается в `DEFAULT_TIMEZONE` на сервере, как в старой панели: браузер не
 * знает, в каком поясе проект.
 */
const LOCAL_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

export class ContestConditionsDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  joinButtonLabel?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  resultsButtonLabel?: string;

  @IsBoolean()
  notifyWinners: boolean;

  @IsBoolean()
  publishResultsInPost: boolean;

  /** Пусто — открывать вручную. */
  @IsOptional()
  @Matches(LOCAL_DATETIME)
  startsAt?: string;

  /** Пусто — разыгрывать вручную. */
  @IsOptional()
  @Matches(LOCAL_DATETIME)
  endsAt?: string;

  @IsArray()
  @IsUUID('4', { each: true })
  requiredGroupIds: string[];
}

export class PublicationDto {
  @IsString()
  @IsNotEmpty()
  text: string;

  @IsArray()
  @ArrayMaxSize(10)
  @IsUUID('4', { each: true })
  attachmentIds: string[];

  /** Меняется только у неопубликованного — после отправки игнорируется. */
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  groupIds?: string[];
}

export class CreateContestWithPostDto extends ContestConditionsDto {
  @IsString()
  @IsNotEmpty()
  text: string;

  @IsArray()
  @ArrayMaxSize(10)
  @IsUUID('4', { each: true })
  attachmentIds: string[];

  @IsArray()
  @IsUUID('4', { each: true })
  groupIds: string[];

  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  prizes: string[];
}

export class PrizeLabelsDto {
  /** Подписи мест по порядку: первая — первое место. */
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  prizes: string[];
}

export class ManualParticipantsDto {
  @IsString()
  @IsNotEmpty()
  text: string;

  /** Платформа строк без ссылки и ника. */
  @IsIn(['max', 'vk'])
  platform: 'max' | 'vk';
}

export class WinnerDto {
  @IsUUID('4')
  participantId: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class ParticipantsQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}
