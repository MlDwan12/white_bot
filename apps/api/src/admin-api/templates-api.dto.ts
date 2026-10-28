import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class ScheduleDto {
  @IsIn(['daily', 'weekly', 'monthly', 'custom'])
  mode: 'daily' | 'weekly' | 'monthly' | 'custom';

  /** «ЧЧ:ММ»; формат проверяет `buildCron` — с понятным текстом отказа. */
  @IsString()
  time: string;

  @IsInt()
  @Min(0)
  @Max(6)
  weekday: number;

  @IsInt()
  @Min(1)
  @Max(31)
  monthday: number;

  @IsString()
  @MaxLength(200)
  custom: string;
}

export class TemplateDto {
  @IsString()
  // Пустой редактор отдаёт "" или одни переводы строк — такой пост платформы не примут.
  @Matches(/\S/)
  @MaxLength(10_000)
  text: string;

  @IsOptional()
  @IsString()
  @MaxLength(10_000)
  vkTextOverride?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10_000)
  maxTextOverride?: string;

  @ValidateNested()
  @Type(() => ScheduleDto)
  schedule: ScheduleDto;

  @IsArray()
  @IsUUID('4', { each: true })
  groupIds: string[];

  @IsArray()
  @ArrayMaxSize(10)
  @IsUUID('4', { each: true })
  attachmentIds: string[];
}
