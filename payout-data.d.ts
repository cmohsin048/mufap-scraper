import type { FundReturnResult } from './payout-returns';
export function loadFundReturns(client: { rpc: Function }, options: {
  fundId: string; from: string; to: string; maxNavAgeDays?: number;
}): Promise<FundReturnResult>;
