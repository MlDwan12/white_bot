import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsDate,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';

export class DeletePublishedDto {
  /**
   * Группы, из которых удалять. Пусто — значит отовсюду: на пост может
   * пожаловаться одна площадка, и сносить его везде из-за этого незачем.
   */
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('4', { each: true })
  groupIds?: string[];
}

export class EditPublishedDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  text?: string;

  @IsOptional()
  @IsString()
  vkTextOverride?: string | null;

  @IsOptional()
  @IsString()
  maxTextOverride?: string | null;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  autoDeleteAt?: Date | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  autoDeleteAfterMinutes?: number | null;
}
