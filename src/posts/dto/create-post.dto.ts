import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsDate,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';

export class CreatePostDto {
  @IsString()
  @IsNotEmpty()
  text: string;

  /** Overrides the shared text on VK only; omit to use `text`. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  vkTextOverride?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  maxTextOverride?: string;

  /** Frozen at creation: groups added to a tag later don't join this campaign. */
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  groupIds: string[];

  /**
   * Ids of previously uploaded files (POST /media), in display order.
   * Attachments are shared across platforms — only text has per-platform
   * overrides, as PLAN.md fixes for the MVP.
   */
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  attachmentIds?: string[];

  /** Omit to publish as soon as the campaign is started. */
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  scheduledAt?: Date;
}
