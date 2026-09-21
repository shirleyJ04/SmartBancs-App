import { IsIn, IsString, Length, Matches, MaxLength, MinLength } from 'class-validator';

export class CreateTransferDto {
  @IsString()
  @Matches(/^ACC-\d{3,5}$/)
  fromAccount!: string;

  @IsString()
  @Matches(/^ACC-\d{3,5}$/)
  toAccount!: string;

  @IsString()
  @Matches(/^\d+(\.\d{1,2})?$/)
  amount!: string;

  @IsString()
  @Length(3, 3)
  @IsIn(['USD'])
  currency!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  idempotencyKey!: string;
}
