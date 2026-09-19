import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';

/**
 * Параметры argon2id. Значения — рекомендация OWASP для интерактивного входа:
 * 19 МиБ памяти, две итерации, параллелизм 1.
 *
 * Память здесь важнее числа итераций: именно она делает перебор на видеокартах
 * невыгодным, потому что памяти на GPU-ядро мало. Поднимать бесконтрольно
 * нельзя — эти же 19 МиБ выделяются на каждую попытку входа, так что параметры
 * идут в связке с ограничителем попыток.
 */
// Значение Algorithm.Argon2id. Константа не импортируется: это ambient const
// enum, а при isolatedModules к таким обращаться нельзя.
const ARGON2ID = 2;

const OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19 * 1024,
  timeCost: 2,
  parallelism: 1,
};

@Injectable()
export class PasswordService {
  hash(password: string): Promise<string> {
    return hash(password, OPTIONS);
  }

  /**
   * Проверка. Соль и параметры лежат в самой строке хеша, поэтому старые
   * хеши продолжают проверяться даже после смены `OPTIONS`.
   */
  async verify(passwordHash: string, password: string): Promise<boolean> {
    try {
      return await verify(passwordHash, password, OPTIONS);
    } catch {
      // Битая или чужого формата строка — это «пароль не подошёл», а не
      // повод уронить вход пятисоткой.
      return false;
    }
  }
}
