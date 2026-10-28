import { Module } from '@nestjs/common';
import { TokenEncryptionService } from './token-encryption.service';

@Module({
  providers: [TokenEncryptionService],
  exports: [TokenEncryptionService],
})
export class CryptoModule {}
