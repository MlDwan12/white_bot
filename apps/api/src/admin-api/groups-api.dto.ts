import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/** Теги без `#`, пробелов по краям и повторов — как их складывала старая панель. */
const cleanTags = ({ value }: { value: unknown }) =>
  Array.isArray(value)
    ? [
        ...new Set(
          value
            .filter((t): t is string => typeof t === 'string')
            .map((t) => t.trim().replace(/^#/, ''))
            .filter(Boolean),
        ),
      ]
    : value;

export class TagsDto {
  @Transform(cleanTags)
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  tags: string[];
}

export class ConnectVkDto {
  @IsString()
  @IsNotEmpty()
  token: string;

  @IsOptional()
  @Transform(cleanTags)
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  tags?: string[];
}

export class ReplaceTokenDto {
  @IsString()
  @IsNotEmpty()
  token: string;
}

export class PastedVkAuthDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  pasted: string;
}
