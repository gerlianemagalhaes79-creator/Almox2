export interface Item {
  id: number;
  name: string;
  description: string;
  quantity: number;
  min_quantity: number;
  expiry_date: string | null;
  origin: 'contract' | 'extra';
  unit_price: number;
  supplier: string | null;
  category: string | null;
  batch_number: string | null;
}

export interface Transaction {
  id: number;
  item_id: number;
  item_name: string;
  type: 'entry' | 'exit';
  quantity: number;
  sector?: string;
  date: string;
}
