import { ArrayUnique, IsArray, IsOptional, IsString } from 'class-validator';

export class ConfirmMaxGroupDto {
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  tags?: string[];
}
