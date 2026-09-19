import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';

export class CreateContestDto {
  @IsString()
  @IsNotEmpty()
  title: string;

  /** Анонс-пост, в доставки которого вшивается кнопка участия. */
  @IsOptional()
  @IsUUID('4')
  postId?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  joinButtonLabel?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  resultsButtonLabel?: string;

  @IsOptional()
  @IsBoolean()
  notifyWinners?: boolean;

  /** Дописывать ли победителей в текст анонса. Временно, до мини-аппа. */
  @IsOptional()
  @IsBoolean()
  publishResultsInPost?: boolean;
}

export class PrizeDto {
  @IsInt()
  @Min(1)
  place: number;

  @IsString()
  @IsNotEmpty()
  label: string;
}

export class SetPrizesDto {
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => PrizeDto)
  prizes: PrizeDto[];
}

export class AddParticipantsDto {
  /** Список строками, по одному участнику на строку. */
  @IsString()
  @IsNotEmpty()
  text: string;
}

export class SetWinnerDto {
  @IsUUID('4')
  participantId: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  note?: string;
}
