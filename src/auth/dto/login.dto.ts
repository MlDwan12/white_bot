import { IsEmail, IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class LoginDto {
  @IsEmail()
  email: string;

  @IsString()
  @IsNotEmpty()
  // Верхняя граница не ради удобства: argon2 считает тем дольше, чем длиннее
  // вход, и мегабайтный «пароль» стал бы способом занять сервер.
  @MaxLength(256)
  password: string;
}
