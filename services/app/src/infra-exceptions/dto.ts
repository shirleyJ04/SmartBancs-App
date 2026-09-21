import { IsIn, IsObject, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class CreateInfraExceptionDto {
  @IsUUID()
  correlationId!: string;

  @IsString()
  @IsIn(['api', 'db', 'worker', 'ai', 'emitter', 'client'])
  component!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(64)
  errorCode!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  message!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  operation?: string;

  @IsOptional()
  @IsObject()
  detail?: Record<string, unknown>;
}
