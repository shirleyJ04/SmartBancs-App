import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class CreateRawTransactionDto {
  @IsString()
  @Matches(/^txn-[\w-]+$/i)
  @MaxLength(64)
  uid!: string;

  @IsString()
  @Matches(/^ACC-\d{3,5}$/)
  account!: string;

  @IsString()
  @Length(2, 2)
  typeCode!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  typeName!: string;

  @IsString()
  @IsIn(['D', 'C'])
  natureCode!: string;

  @IsString()
  @Length(3, 3)
  productCode!: string;

  @IsString()
  @IsIn(['COMPLETED', 'REJECTED'])
  status!: string;

  @IsString()
  @Matches(/^\d+(\.\d{1,2})?$/)
  amount!: string;

  @IsString()
  @Length(3, 3)
  @IsIn(['USD'])
  currency!: string;

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  counterpartName!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  category!: string;

  @IsOptional()
  @IsString()
  @IsIn(['ACCOUNT_NOT_FOUND', 'INSUFFICIENT_FUNDS', 'CARD_DECLINED', ''])
  rejectReason?: string;
}

export class CreateRawTransactionBatchDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => CreateRawTransactionDto)
  items!: CreateRawTransactionDto[];
}
