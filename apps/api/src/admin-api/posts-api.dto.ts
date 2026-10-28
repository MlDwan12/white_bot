import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

/** «Настенное» время из `datetime-local`, читается в `DEFAULT_TIMEZONE`. */
export const LOCAL_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

const YEAR_MINUTES = 60 * 24 * 365;

class PostTextDto {
  @IsString()
  // Пустой редактор отдаёт "" или одни переводы строк — такой пост платформы не примут.
  @Matches(/\S/)
  @MaxLength(10_000)
  text: string;

  /** Пусто — общий текст. */
  @IsOptional()
  @IsString()
  @MaxLength(10_000)
  vkTextOverride?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10_000)
  maxTextOverride?: string;

  @IsArray()
  @ArrayMaxSize(10)
  @IsUUID('4', { each: true })
  attachmentIds: string[];

  /** null — не удалять. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(YEAR_MINUTES)
  autoDeleteAfterMinutes?: number | null;
}

export class DraftPostDto extends PostTextDto {
  @IsArray()
  @IsUUID('4', { each: true })
  groupIds: string[];

  @IsOptional()
  @Matches(LOCAL_DATETIME)
  scheduledAt?: string;
}

export class CreatePostDto extends DraftPostDto {
  /** false — сохранить черновиком. */
  @IsBoolean()
  send: boolean;
}

export class EditPublishedDto extends PostTextDto {}

export class DeletePublishedDto {
  /** Пустой список сервис понял бы как «отовсюду» — поэтому обязателен. */
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('4', { each: true })
  groupIds: string[];
}

export class DirectMessageTargetDto {
  @IsIn(['user', 'group', 'all'])
  mode: 'user' | 'group' | 'all';

  @ValidateIf((o: DirectMessageTargetDto) => o.mode === 'user')
  @IsUUID('4')
  platformUserId?: string;

  @ValidateIf((o: DirectMessageTargetDto) => o.mode === 'group')
  @IsUUID('4')
  groupId?: string;
}

export class NewDirectMessageDto extends DirectMessageTargetDto {
  @IsString()
  // Пустой редактор отдаёт "" или одни переводы строк — такой пост платформы не примут.
  @Matches(/\S/)
  @MaxLength(10_000)
  text: string;

  @IsArray()
  @ArrayMaxSize(10)
  @IsUUID('4', { each: true })
  attachmentIds: string[];
}
