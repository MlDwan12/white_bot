import { IsNotEmpty, IsString } from 'class-validator';

export class ReplaceVkTokenDto {
  @IsString()
  @IsNotEmpty()
  token: string;
}
