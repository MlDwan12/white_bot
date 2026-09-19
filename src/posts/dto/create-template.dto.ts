import {
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  ValidateIf,
} from 'class-validator';

export class CreateTemplateDto {
  @IsString()
  @IsNotEmpty()
  text: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  vkTextOverride?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  maxTextOverride?: string;

  /** Standard five-field cron, e.g. `0 10 * * 1` for Mondays at 10:00. */
  @IsString()
  @IsNotEmpty()
  recurrenceRule: string;

  /** IANA name; falls back to DEFAULT_TIMEZONE. Validated together with the rule. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  timezone?: string;

  /** Editable afterwards — unlike a one-off post, whose targets are frozen. */
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  groupIds: string[];

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  attachmentIds?: string[];
}

/**
 * `@ValidateIf((_, v) => v !== undefined)` rather than `@IsOptional()` on every
 * field whose column is not nullable.
 *
 * `@IsOptional()` skips validation for `null` as well as `undefined`, and
 * `whitelist: true` keeps the key because the property is decorated — so an
 * explicit `null` sails through the pipe and reaches Prisma. For
 * `recurrenceRule` that was not a 500 but something worse: the row lost its
 * rule, vanished from `fireDueTemplates`, stopped publishing with no log line,
 * and could no longer be reached through the templates API — while it now
 * passed the `recurrenceRule` guards on the campaign endpoints and could be
 * "scheduled" into a post with zero deliveries that settles as `sent`.
 */
export class UpdateTemplateDto {
  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @IsNotEmpty()
  text?: string;

  /**
   * Nullable on purpose: `null` clears the override so the shared text applies
   * again. Omitting these fields entirely would make an override set at
   * creation impossible to edit — the global ValidationPipe strips unknown
   * properties silently, so the API would answer 200 and change nothing.
   */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @IsNotEmpty()
  vkTextOverride?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @IsNotEmpty()
  maxTextOverride?: string | null;

  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @IsNotEmpty()
  recurrenceRule?: string;

  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @IsNotEmpty()
  timezone?: string;

  @ValidateIf((_, value) => value !== undefined)
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  groupIds?: string[];

  /**
   * Replaces the attachment list wholesale; an empty array removes them all.
   * Missing here, a panel PATCH that changed a template's attachments answered
   * 200 and changed nothing — the same silent no-op the override fields above
   * are annotated against, and it made attachments unchangeable after creation.
   */
  @ValidateIf((_, value) => value !== undefined)
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  attachmentIds?: string[];
}

export class PauseTemplateDto {
  @IsBoolean()
  paused: boolean;
}
