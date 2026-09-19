export interface NavRecord { fund_id: string; nav_date: string; nav: number | string; }
export interface PayoutRecord { fund_id: string; payout_date: string; payout_per_unit: number | string; ex_nav: number | string | null; }
export interface PayoutCoverage { fund_id: string; date_from: string; date_to: string; status: 'pending' | 'verified' | 'needs_review'; checked_at: string; }
export interface FundReturnInput {
  fundId: string; from: string; to: string; navRecords: NavRecord[]; payouts: PayoutRecord[];
  coverage?: PayoutCoverage[]; maxNavAgeDays?: number;
}
export interface FundReturnResult {
  fundId: string; requestedFrom: string; requestedTo: string; actualFrom: string | null; actualTo: string | null;
  status: 'ready' | 'partial' | 'unavailable'; reasons: string[];
  navReturnPct: number | null; cashReturnPct: number | null; totalReturnPct: number | null;
  simpleAnnualizedReturnPct: number | null; cagrPct: number | null;
  payoutPerInitialUnit: number | null; distributionCount: number; reinvestmentFactor: number | null;
  missingCoverage: Array<{ from: string; to: string }>;
}
export function calculateFundReturns(input: FundReturnInput): FundReturnResult;
export function missingCoverage(fundId: string, from: string, to: string, coverage?: PayoutCoverage[]): Array<{ from: string; to: string }>;
