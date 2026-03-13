import React, { useState, useEffect } from 'react';
import { 
  Package, 
  ArrowUpRight, 
  ArrowDownLeft, 
  AlertTriangle, 
  Plus, 
  History, 
  LayoutDashboard,
  Calendar,
  Search,
  Settings,
  ChevronRight,
  X,
  LogOut,
  LogIn
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Item, Transaction } from './types';
import { 
  db, 
  auth, 
  signIn, 
  signOut, 
  handleFirestoreError, 
  OperationType 
} from './firebase';
import { 
  collection, 
  onSnapshot, 
  query, 
  orderBy, 
  addDoc, 
  updateDoc, 
  doc, 
  serverTimestamp, 
  runTransaction,
  getDoc
} from 'firebase/firestore';
import { onAuthStateChanged, User } from 'firebase/auth';

interface ItemGroup {
  name: string;
  total_quantity: number;
  min_quantity: number;
  category: string | null;
  supplier: string | null;
  batches: Item[];
}

const SECTORS = [
  'Imagem', 'Ilha', 'Pé Diabético', 'Direção', 'Setor Pessoal', 
  'CER', 'Setor de Terapias', 'SSVV', 'Recepção', 
  'Higienização', 'Manutenção', 'Almoxarifado'
];

export default function App() {
  const [items, setItems] = useState<Item[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [user, setUser] = useState<User | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [activeTab, setActiveTab] = useState<'dashboard' | 'inventory' | 'history'>('dashboard');
  const [showAddModal, setShowAddModal] = useState(false);
  const [showTransactionModal, setShowTransactionModal] = useState<{show: boolean, type: 'entry' | 'exit', item?: Item}>({ show: false, type: 'entry' });
  const [showDetailModal, setShowDetailModal] = useState<{show: boolean, type: 'low_stock' | 'expiry', items: Item[]}>({ show: false, type: 'low_stock', items: [] });
  
  // Form states
  const [newItem, setNewItem] = useState({ 
    name: '', 
    min_quantity: 5, 
    expiry_date: '', 
    origin: 'extra' as 'contract' | 'extra', 
    unit_price: 0,
    supplier: '',
    category: 'Expediente',
    initial_quantity: 1,
    batch_number: ''
  });
  const [transactionQty, setTransactionQty] = useState(1);
  const [selectedSector, setSelectedSector] = useState(SECTORS[0]);
  const [selectedItemId, setSelectedItemId] = useState<number | ''>('');
  const [selectedItemName, setSelectedItemName] = useState<string>('');
  const [basket, setBasket] = useState<{item_id: number, quantity: number}[]>([]);
  const [searchTerm, setSearchTerm] = useState('');

  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setUser(user);
      setIsAuthReady(true);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!isAuthReady || !user) {
      setItems([]);
      setTransactions([]);
      return;
    }

    // Real-time items
    const itemsQuery = query(collection(db, 'items'), orderBy('name', 'asc'));
    const unsubscribeItems = onSnapshot(itemsQuery, (snapshot) => {
      const itemsData = snapshot.docs.map(doc => ({
        id: doc.id as any, // Firebase IDs are strings, but the type expects number. We'll handle this.
        ...doc.data()
      })) as Item[];
      setItems(itemsData);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'items');
    });

    // Real-time transactions
    const transQuery = query(collection(db, 'transactions'), orderBy('date', 'desc'));
    const unsubscribeTrans = onSnapshot(transQuery, (snapshot) => {
      const transData = snapshot.docs.map(doc => ({
        id: doc.id as any,
        ...doc.data(),
        date: doc.data().date?.toDate?.()?.toISOString() || new Date().toISOString()
      })) as Transaction[];
      setTransactions(transData);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'transactions');
    });

    return () => {
      unsubscribeItems();
      unsubscribeTrans();
    };
  }, [isAuthReady, user]);

  useEffect(() => {
    if (showTransactionModal.show && showTransactionModal.type === 'exit') {
      if (showTransactionModal.item) {
        setBasket([{ item_id: showTransactionModal.item.id, quantity: 1 }]);
      } else {
        setBasket([]);
      }
      setTransactionQty(1);
      setSelectedItemId('');
      setSelectedItemName('');
    }
  }, [showTransactionModal.show, showTransactionModal.type, showTransactionModal.item]);

  const toggleExpand = (name: string) => {
    const newSet = new Set(expandedItems);
    if (newSet.has(name)) newSet.delete(name);
    else newSet.add(name);
    setExpandedItems(newSet);
  };

  const fetchData = async () => {
    try {
      const [itemsRes, transRes] = await Promise.all([
        fetch('/api/items'),
        fetch('/api/transactions')
      ]);

      if (!itemsRes.ok || !transRes.ok) {
        const failedRes = !itemsRes.ok ? itemsRes : transRes;
        throw new Error(`Erro ao carregar dados: ${failedRes.status} ${failedRes.statusText}`);
      }

      const contentTypeItems = itemsRes.headers.get("content-type");
      const contentTypeTrans = transRes.headers.get("content-type");

      if (!contentTypeItems?.includes("application/json") || !contentTypeTrans?.includes("application/json")) {
        throw new Error("O servidor retornou uma resposta inválida (não JSON). Verifique se o backend está rodando.");
      }

      setItems(await itemsRes.json());
      setTransactions(await transRes.json());
    } catch (error: any) {
      console.error('Erro ao buscar dados:', error);
      // Don't alert on initial fetch to avoid annoying the user if the server is just starting
    }
  };

  const handleAddItem = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    
    try {
      const initial_qty = isNaN(newItem.initial_quantity) ? 0 : newItem.initial_quantity;
      const min_qty = isNaN(newItem.min_quantity) ? 5 : newItem.min_quantity;
      const price = isNaN(newItem.unit_price) ? 0 : newItem.unit_price;

      // Check if item already exists with the same name AND batch
      const existingItem = items.find(i => 
        i.name.toLowerCase() === newItem.name.toLowerCase() && 
        (i.batch_number || '').toLowerCase() === (newItem.batch_number || '').toLowerCase()
      );

      if (existingItem) {
        await runTransaction(db, async (transaction) => {
          const itemRef = doc(db, 'items', existingItem.id.toString());
          const itemDoc = await transaction.get(itemRef);
          if (!itemDoc.exists()) throw new Error("Item não encontrado!");

          const newQty = (itemDoc.data().quantity || 0) + initial_qty;
          
          transaction.update(itemRef, {
            quantity: newQty,
            min_quantity: min_qty,
            expiry_date: newItem.expiry_date || existingItem.expiry_date,
            unit_price: price || existingItem.unit_price,
            supplier: newItem.supplier || existingItem.supplier,
            category: newItem.category || existingItem.category,
            updatedAt: serverTimestamp()
          });

          const transRef = doc(collection(db, 'transactions'));
          transaction.set(transRef, {
            item_id: existingItem.id.toString(),
            item_name: existingItem.name,
            type: 'entry',
            quantity: initial_qty,
            sector: null,
            date: serverTimestamp(),
            user_email: user.email
          });
        });
      } else {
        const itemData = {
          name: newItem.name,
          min_quantity: min_qty,
          expiry_date: newItem.expiry_date || null,
          origin: newItem.origin,
          unit_price: price,
          supplier: newItem.supplier || null,
          category: newItem.category || null,
          batch_number: newItem.batch_number || null,
          quantity: initial_qty,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        };

        const itemRef = await addDoc(collection(db, 'items'), itemData);
        
        await addDoc(collection(db, 'transactions'), {
          item_id: itemRef.id,
          item_name: newItem.name,
          type: 'entry',
          quantity: initial_qty,
          sector: null,
          date: serverTimestamp(),
          user_email: user.email
        });
      }

      setShowAddModal(false);
      setNewItem({ 
        name: '', 
        min_quantity: 5, 
        expiry_date: '', 
        origin: 'extra', 
        unit_price: 0,
        supplier: '',
        category: 'Expediente',
        initial_quantity: 1,
        batch_number: ''
      });
    } catch (error: any) {
      console.error('Erro ao salvar item:', error);
      alert(`Erro ao salvar item: ${error.message}`);
    }
  };

  const handleTransaction = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    
    try {
      if (showTransactionModal.type === 'exit') {
        if (basket.length === 0) return;
        
        await runTransaction(db, async (transaction) => {
          for (const b of basket) {
            const itemRef = doc(db, 'items', b.item_id.toString());
            const itemDoc = await transaction.get(itemRef);
            if (!itemDoc.exists()) throw new Error(`Item ${b.item_id} não encontrado!`);
            
            const currentQty = itemDoc.data().quantity || 0;
            if (currentQty < b.quantity) throw new Error(`Estoque insuficiente para ${itemDoc.data().name}`);

            transaction.update(itemRef, {
              quantity: currentQty - b.quantity,
              updatedAt: serverTimestamp()
            });

            const transRef = doc(collection(db, 'transactions'));
            transaction.set(transRef, {
              item_id: b.item_id.toString(),
              item_name: itemDoc.data().name,
              type: 'exit',
              quantity: b.quantity,
              sector: selectedSector,
              date: serverTimestamp(),
              user_email: user.email
            });
          }
        });
      } else {
        const item = showTransactionModal.item || items.find(i => i.id === selectedItemId);
        if (!item) {
          alert('Por favor, selecione um item.');
          return;
        }
        
        await runTransaction(db, async (transaction) => {
          const itemRef = doc(db, 'items', item.id.toString());
          const itemDoc = await transaction.get(itemRef);
          if (!itemDoc.exists()) throw new Error("Item não encontrado!");

          transaction.update(itemRef, {
            quantity: (itemDoc.data().quantity || 0) + transactionQty,
            updatedAt: serverTimestamp()
          });

          const transRef = doc(collection(db, 'transactions'));
          transaction.set(transRef, {
            item_id: item.id.toString(),
            item_name: item.name,
            type: 'entry',
            quantity: transactionQty,
            sector: null,
            date: serverTimestamp(),
            user_email: user.email
          });
        });
      }

      setShowTransactionModal({ show: false, type: 'entry' });
      setTransactionQty(1);
      setSelectedSector(SECTORS[0]);
      setSelectedItemId('');
      setBasket([]);
    } catch (error: any) {
      console.error('Erro na transação:', error);
      alert(`Erro na movimentação: ${error.message}`);
    }
  };

  const isNearExpiry = (dateStr: string | null) => {
    if (!dateStr) return false;
    const expiry = new Date(dateStr);
    const now = new Date();
    const oneMonthFromNow = new Date();
    oneMonthFromNow.setMonth(now.getMonth() + 1);
    return expiry <= oneMonthFromNow && expiry >= now;
  };

  const isLowStock = (item: Item) => item.quantity <= item.min_quantity;

  const lowStockItems = items.filter(isLowStock);
  const nearExpiryItems = items.filter(i => isNearExpiry(i.expiry_date));
  const totalVolume = items.reduce((sum, item) => sum + item.quantity, 0);

  const filteredItems = items.filter(i => 
    i.name.toLowerCase().includes(searchTerm.toLowerCase()) || 
    i.supplier?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    i.category?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    i.batch_number?.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const groupedItems = filteredItems.reduce((acc, item) => {
    if (!acc[item.name]) {
      acc[item.name] = {
        name: item.name,
        total_quantity: 0,
        min_quantity: item.min_quantity,
        category: item.category,
        supplier: item.supplier,
        batches: []
      };
    }
    acc[item.name].total_quantity += item.quantity;
    acc[item.name].batches.push(item);
    return acc;
  }, {} as Record<string, ItemGroup>);

  const groupedArray: ItemGroup[] = Object.values(groupedItems);

  if (!isAuthReady) {
    return (
      <div className="min-h-screen bg-[#F5F5F4] flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#1C1917]"></div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-[#F5F5F4] flex items-center justify-center p-6">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-white p-10 rounded-3xl border border-[#E7E5E4] shadow-xl max-w-md w-full text-center"
        >
          <div className="bg-[#1C1917] p-4 rounded-2xl inline-block mb-6">
            <Package className="text-white w-10 h-10" />
          </div>
          <h1 className="text-3xl font-bold mb-2">Almoxarifado</h1>
          <p className="text-[#78716C] mb-8">Faça login para gerenciar o estoque do hospital.</p>
          <button 
            onClick={signIn}
            className="w-full bg-[#1C1917] text-white py-4 rounded-2xl font-bold flex items-center justify-center gap-3 hover:bg-[#292524] transition-all"
          >
            <LogIn size={20} /> Entrar com Google
          </button>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F5F5F4] text-[#1C1917] font-sans">
      {/* Sidebar */}
      <aside className="fixed left-0 top-0 h-full w-64 bg-white border-r border-[#E7E5E4] p-6 flex flex-col gap-8 z-10">
        <div className="flex items-center gap-3 px-2">
          <div className="bg-[#1C1917] p-2 rounded-lg">
            <Package className="text-white w-6 h-6" />
          </div>
          <h1 className="font-bold text-xl tracking-tight">Almoxarifado</h1>
        </div>

        <div className="px-2 py-4 bg-[#F5F5F4] rounded-2xl flex items-center gap-3">
          <img src={user.photoURL || ''} alt="" className="w-10 h-10 rounded-full border-2 border-white" />
          <div className="overflow-hidden">
            <p className="text-xs font-bold truncate">{user.displayName}</p>
            <p className="text-[10px] text-[#78716C] truncate">{user.email}</p>
          </div>
        </div>

        <nav className="flex flex-col gap-1">
          <button 
            onClick={() => setActiveTab('dashboard')}
            className={`flex items-center gap-3 px-4 py-3 rounded-xl transition-all ${activeTab === 'dashboard' ? 'bg-[#F5F5F4] font-semibold' : 'hover:bg-[#FAFAF9] text-[#57534E]'}`}
          >
            <LayoutDashboard size={20} /> Dashboard
          </button>
          <button 
            onClick={() => setActiveTab('inventory')}
            className={`flex items-center gap-3 px-4 py-3 rounded-xl transition-all ${activeTab === 'inventory' ? 'bg-[#F5F5F4] font-semibold' : 'hover:bg-[#FAFAF9] text-[#57534E]'}`}
          >
            <Package size={20} /> Estoque
          </button>
          <button 
            onClick={() => setActiveTab('history')}
            className={`flex items-center gap-3 px-4 py-3 rounded-xl transition-all ${activeTab === 'history' ? 'bg-[#F5F5F4] font-semibold' : 'hover:bg-[#FAFAF9] text-[#57534E]'}`}
          >
            <History size={20} /> Histórico
          </button>
        </nav>

        <div className="mt-auto pt-6 border-t border-[#E7E5E4] space-y-2">
          <button className="flex items-center gap-3 px-4 py-3 rounded-xl text-[#57534E] hover:bg-[#FAFAF9] w-full transition-all">
            <Settings size={20} /> Configurações
          </button>
          <button 
            onClick={signOut}
            className="flex items-center gap-3 px-4 py-3 rounded-xl text-rose-600 hover:bg-rose-50 w-full transition-all font-bold"
          >
            <LogOut size={20} /> Sair
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="ml-64 p-10 max-w-7xl mx-auto">
        <header className="flex justify-between items-center mb-10">
          <div>
            <h2 className="text-3xl font-bold tracking-tight mb-1">
              {activeTab === 'dashboard' && 'Visão Geral'}
              {activeTab === 'inventory' && 'Gerenciamento de Estoque'}
              {activeTab === 'history' && 'Histórico de Movimentações'}
            </h2>
            <p className="text-[#78716C]">
              {new Date().toLocaleDateString('pt-BR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
            </p>
          </div>
          
          <div className="flex gap-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-[#A8A29E]" size={18} />
              <input 
                type="text" 
                placeholder="Buscar itens..."
                className="pl-10 pr-4 py-2 bg-white border border-[#E7E5E4] rounded-xl focus:outline-none focus:ring-2 focus:ring-[#1C1917]/10 w-64 transition-all"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>
            <button 
              onClick={() => setShowAddModal(true)}
              className="bg-[#1C1917] text-white px-5 py-2 rounded-xl font-medium flex items-center gap-2 hover:bg-[#292524] transition-all shadow-sm"
            >
              <Plus size={20} /> Entrada
            </button>
            <button 
              onClick={() => setShowTransactionModal({ show: true, type: 'exit' })}
              className="bg-rose-600 text-white px-5 py-2 rounded-xl font-medium flex items-center gap-2 hover:bg-rose-700 transition-all shadow-sm"
            >
              <ArrowUpRight size={20} /> Saída
            </button>
          </div>
        </header>

        <AnimatePresence mode="wait">
          {activeTab === 'dashboard' && (
            <motion.div 
              key="dashboard"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="grid grid-cols-1 md:grid-cols-3 gap-6"
            >
              {/* Stats Cards */}
              <div className="bg-white p-6 rounded-3xl border border-[#E7E5E4] shadow-sm">
                <div className="flex justify-between items-start mb-4">
                  <div className="bg-emerald-100 p-3 rounded-2xl text-emerald-600">
                    <Package size={24} />
                  </div>
                </div>
                <p className="text-[#78716C] font-medium mb-1">Volume em Estoque</p>
                <h3 className="text-4xl font-bold">{totalVolume}</h3>
                <p className="text-xs text-[#A8A29E] mt-2 font-bold uppercase tracking-wider">{groupedArray.length} tipos de itens</p>
              </div>

              <div 
                onClick={() => lowStockItems.length > 0 && setShowDetailModal({ show: true, type: 'low_stock', items: lowStockItems })}
                className={`p-6 rounded-3xl border shadow-sm transition-all cursor-pointer ${lowStockItems.length > 0 ? 'bg-orange-50 border-orange-200 hover:bg-orange-100' : 'bg-white border-[#E7E5E4]'}`}
              >
                <div className="flex justify-between items-start mb-4">
                  <div className={`p-3 rounded-2xl ${lowStockItems.length > 0 ? 'bg-orange-100 text-orange-600' : 'bg-gray-100 text-gray-600'}`}>
                    <AlertTriangle size={24} />
                  </div>
                </div>
                <p className="text-[#78716C] font-medium mb-1">Estoque Baixo</p>
                <h3 className={`text-4xl font-bold ${lowStockItems.length > 0 ? 'text-orange-600' : ''}`}>{lowStockItems.length}</h3>
              </div>

              <div 
                onClick={() => nearExpiryItems.length > 0 && setShowDetailModal({ show: true, type: 'expiry', items: nearExpiryItems })}
                className={`p-6 rounded-3xl border shadow-sm transition-all cursor-pointer ${nearExpiryItems.length > 0 ? 'bg-red-50 border-red-200 hover:bg-red-100' : 'bg-white border-[#E7E5E4]'}`}
              >
                <div className="flex justify-between items-start mb-4">
                  <div className={`p-3 rounded-2xl ${nearExpiryItems.length > 0 ? 'bg-red-100 text-red-600' : 'bg-gray-100 text-gray-600'}`}>
                    <Calendar size={24} />
                  </div>
                </div>
                <p className="text-[#78716C] font-medium mb-1">Vencimento Próximo</p>
                <h3 className={`text-4xl font-bold ${nearExpiryItems.length > 0 ? 'text-red-600' : ''}`}>{nearExpiryItems.length}</h3>
              </div>

              {/* Alerts Section */}
              <div className="md:col-span-2 space-y-6">
                <div className="bg-white p-8 rounded-3xl border border-[#E7E5E4] shadow-sm">
                  <h4 className="text-xl font-bold mb-6 flex items-center gap-2">
                    <AlertTriangle className="text-orange-500" size={20} /> Alertas Críticos
                  </h4>
                  <div className="space-y-4">
                    {lowStockItems.length === 0 && nearExpiryItems.length === 0 && (
                      <p className="text-[#A8A29E] italic">Nenhum alerta no momento.</p>
                    )}
                    {lowStockItems.map(item => (
                      <div key={`low-${item.id}`} className="flex items-center justify-between p-4 bg-orange-50 rounded-2xl border border-orange-100">
                        <div className="flex items-center gap-4">
                          <div className="w-10 h-10 bg-orange-200 rounded-full flex items-center justify-center text-orange-700 font-bold">
                            {item.quantity}
                          </div>
                          <div>
                            <p className="font-bold">{item.name}</p>
                            <p className="text-sm text-orange-700">Estoque abaixo do mínimo ({item.min_quantity})</p>
                          </div>
                        </div>
                        <button 
                          onClick={() => setShowTransactionModal({ show: true, type: 'entry', item })}
                          className="bg-orange-600 text-white px-4 py-2 rounded-xl text-sm font-bold hover:bg-orange-700 transition-all"
                        >
                          Repor
                        </button>
                      </div>
                    ))}
                    {nearExpiryItems.map(item => (
                      <div key={`exp-${item.id}`} className="flex items-center justify-between p-4 bg-red-50 rounded-2xl border border-red-100">
                        <div className="flex items-center gap-4">
                          <div className="w-10 h-10 bg-red-200 rounded-full flex items-center justify-center text-red-700">
                            <Calendar size={20} />
                          </div>
                          <div>
                            <p className="font-bold">{item.name}</p>
                            <p className="text-sm text-red-700">Vence em: {new Date(item.expiry_date!).toLocaleDateString('pt-BR')}</p>
                          </div>
                        </div>
                        <button 
                          onClick={() => setShowTransactionModal({ show: true, type: 'exit', item })}
                          className="bg-red-600 text-white px-4 py-2 rounded-xl text-sm font-bold hover:bg-red-700 transition-all"
                        >
                          Retirar
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Recent Activity */}
              <div className="bg-white p-8 rounded-3xl border border-[#E7E5E4] shadow-sm">
                <h4 className="text-xl font-bold mb-6">Atividade Recente</h4>
                <div className="space-y-6">
                  {transactions.slice(0, 5).map(t => (
                    <div key={t.id} className="flex gap-4">
                      <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${t.type === 'entry' ? 'bg-emerald-100 text-emerald-600' : 'bg-rose-100 text-rose-600'}`}>
                        {t.type === 'entry' ? <ArrowDownLeft size={18} /> : <ArrowUpRight size={18} />}
                      </div>
                      <div>
                        <p className="font-bold text-sm">{t.item_name}</p>
                        <p className="text-xs text-[#78716C]">
                          {t.type === 'entry' ? 'Entrada' : `Saída para ${t.sector || '---'}`} de {t.quantity} unidades
                        </p>
                        <p className="text-[10px] text-[#A8A29E] mt-1">{new Date(t.date).toLocaleString('pt-BR')}</p>
                      </div>
                    </div>
                  ))}
                  {transactions.length === 0 && <p className="text-[#A8A29E] text-sm italic">Nenhuma movimentação.</p>}
                </div>
              </div>
            </motion.div>
          )}

          {activeTab === 'inventory' && (
            <motion.div 
              key="inventory"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className="bg-white rounded-3xl border border-[#E7E5E4] shadow-sm overflow-hidden"
            >
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-[#FAFAF9] border-bottom border-[#E7E5E4]">
                    <th className="px-6 py-4 font-bold text-sm text-[#78716C] uppercase tracking-wider">Item / Lote</th>
                    <th className="px-6 py-4 font-bold text-sm text-[#78716C] uppercase tracking-wider">Tipo / Fornecedor</th>
                    <th className="px-6 py-4 font-bold text-sm text-[#78716C] uppercase tracking-wider">Origem</th>
                    <th className="px-6 py-4 font-bold text-sm text-[#78716C] uppercase tracking-wider">Preço Un.</th>
                    <th className="px-6 py-4 font-bold text-sm text-[#78716C] uppercase tracking-wider">Quantidade</th>
                    <th className="px-6 py-4 font-bold text-sm text-[#78716C] uppercase tracking-wider">Mínimo</th>
                    <th className="px-6 py-4 font-bold text-sm text-[#78716C] uppercase tracking-wider">Validade</th>
                    <th className="px-6 py-4 font-bold text-sm text-[#78716C] uppercase tracking-wider text-right">Ações</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E7E5E4]">
                  {groupedArray.map(group => (
                    <React.Fragment key={group.name}>
                      <tr 
                        className="bg-[#FAFAF9] hover:bg-[#F5F5F4] transition-all cursor-pointer"
                        onClick={() => toggleExpand(group.name)}
                      >
                        <td className="px-6 py-5">
                          <div className="flex items-center gap-3">
                            <div className={`transition-transform ${expandedItems.has(group.name) ? 'rotate-90' : ''}`}>
                              <ChevronRight size={18} className="text-[#A8A29E]" />
                            </div>
                            <p className="font-bold text-lg">{group.name}</p>
                          </div>
                        </td>
                        <td className="px-6 py-5">
                          <p className="text-sm font-semibold text-[#44403C]">{group.category || '---'}</p>
                          <p className="text-xs text-[#78716C]">{group.supplier || '---'}</p>
                        </td>
                        <td className="px-6 py-5">
                          {(() => {
                            const origins = new Set(group.batches.map(b => b.origin));
                            if (origins.size === 1) {
                              const origin = Array.from(origins)[0];
                              return (
                                <span className={`text-xs font-bold px-2 py-1 rounded-lg ${origin === 'contract' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'}`}>
                                  {origin === 'contract' ? 'Contrato' : 'Extra'}
                                </span>
                              );
                            }
                            return (
                              <span className="text-[10px] font-bold px-2 py-1 rounded-lg bg-gray-100 text-gray-500 uppercase">
                                {group.batches.length} Lotes
                              </span>
                            );
                          })()}
                        </td>
                        <td className="px-6 py-5 font-medium text-[#57534E]">---</td>
                        <td className="px-6 py-5">
                          <div className="flex flex-col items-center justify-center bg-[#F5F5F4] rounded-2xl p-2 border border-[#E7E5E4]">
                            <span className={`text-xl font-black ${group.total_quantity <= group.min_quantity ? 'text-orange-600' : 'text-emerald-600'}`}>
                              {group.total_quantity}
                            </span>
                            <span className="text-[9px] font-bold text-[#A8A29E] uppercase tracking-tighter">Total Geral</span>
                          </div>
                        </td>
                        <td className="px-6 py-5 text-[#57534E] font-medium">{group.min_quantity}</td>
                        <td className="px-6 py-5">
                          <p className="text-xs text-[#A8A29E]">Ver lotes abaixo</p>
                        </td>
                        <td className="px-6 py-5 text-right">
                          <div className="flex flex-col items-end gap-1">
                            <button className="text-xs font-bold text-emerald-600 uppercase tracking-wider hover:underline">
                              {expandedItems.has(group.name) ? 'Recolher' : 'Ver Detalhes'}
                            </button>
                            <span className="text-[10px] text-[#A8A29E] font-medium">
                              {group.batches.length} remessas ativas
                            </span>
                          </div>
                        </td>
                      </tr>
                      
                      {expandedItems.has(group.name) && group.batches.map(item => (
                        <tr key={item.id} className="bg-white hover:bg-[#FAFAF9] transition-all border-l-4 border-emerald-500">
                          <td className="px-12 py-4">
                            <p className="text-sm font-mono font-bold text-[#57534E]">Lote: {item.batch_number || '---'}</p>
                          </td>
                          <td className="px-6 py-4">
                            <p className="text-xs text-[#78716C]">{item.supplier || '---'}</p>
                          </td>
                          <td className="px-6 py-4">
                            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-md ${item.origin === 'contract' ? 'bg-blue-50 text-blue-600' : 'bg-purple-50 text-purple-600'}`}>
                              {item.origin === 'contract' ? 'Contrato' : 'Extra'}
                            </span>
                          </td>
                          <td className="px-6 py-4 text-sm text-[#57534E]">
                            {new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(item.unit_price)}
                          </td>
                          <td className="px-6 py-4">
                            <div className="flex flex-col">
                              <span className={`text-lg font-bold ${item.quantity <= (item.min_quantity || 0) ? 'text-orange-600' : 'text-[#1C1917]'}`}>
                                {item.quantity}
                              </span>
                              <span className="text-[9px] font-bold text-[#A8A29E] uppercase tracking-tighter">Neste Lote</span>
                            </div>
                          </td>
                          <td className="px-6 py-4 text-xs text-[#A8A29E]">---</td>
                          <td className="px-6 py-4">
                            {item.expiry_date ? (
                              <span className={`text-xs ${isNearExpiry(item.expiry_date) ? 'text-red-600 font-bold' : 'text-[#57534E]'}`}>
                                {new Date(item.expiry_date).toLocaleDateString('pt-BR')}
                              </span>
                            ) : (
                              <span className="text-[#A8A29E] text-xs italic">N/A</span>
                            )}
                          </td>
                          <td className="px-6 py-4 text-right space-x-2">
                            <button 
                              onClick={(e) => { e.stopPropagation(); setShowTransactionModal({ show: true, type: 'entry', item }); }}
                              className="p-1.5 text-emerald-600 hover:bg-emerald-50 rounded-lg transition-all"
                              title="Entrada"
                            >
                              <Plus size={16} />
                            </button>
                            <button 
                              onClick={(e) => { e.stopPropagation(); setShowTransactionModal({ show: true, type: 'exit', item }); }}
                              className="p-1.5 text-rose-600 hover:bg-rose-50 rounded-lg transition-all"
                              title="Saída"
                            >
                              <ArrowUpRight size={16} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </React.Fragment>
                  ))}
                </tbody>
                <tfoot className="bg-[#FAFAF9] border-t-2 border-[#E7E5E4]">
                  <tr>
                    <td colSpan={4} className="px-6 py-4 font-bold text-[#57534E] text-right uppercase tracking-wider">Total em Estoque</td>
                    <td className="px-6 py-4">
                      <div className="flex flex-col items-center justify-center bg-[#1C1917] text-white rounded-xl py-2 px-3 shadow-sm">
                        <span className="text-xl font-black">{totalVolume}</span>
                        <span className="text-[8px] font-bold uppercase tracking-tighter opacity-70">Unidades Totais</span>
                      </div>
                    </td>
                    <td colSpan={3}></td>
                  </tr>
                </tfoot>
              </table>
              {filteredItems.length === 0 && (
                <div className="p-20 text-center">
                  <Package className="mx-auto text-[#E7E5E4] mb-4" size={48} />
                  <p className="text-[#78716C]">Nenhum item encontrado.</p>
                </div>
              )}
            </motion.div>
          )}

          {activeTab === 'history' && (
            <motion.div 
              key="history"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className="bg-white rounded-3xl border border-[#E7E5E4] shadow-sm overflow-hidden"
            >
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-[#FAFAF9] border-bottom border-[#E7E5E4]">
                    <th className="px-6 py-4 font-bold text-sm text-[#78716C] uppercase tracking-wider">Data</th>
                    <th className="px-6 py-4 font-bold text-sm text-[#78716C] uppercase tracking-wider">Item</th>
                    <th className="px-6 py-4 font-bold text-sm text-[#78716C] uppercase tracking-wider">Tipo</th>
                    <th className="px-6 py-4 font-bold text-sm text-[#78716C] uppercase tracking-wider">Setor</th>
                    <th className="px-6 py-4 font-bold text-sm text-[#78716C] uppercase tracking-wider text-right">Quantidade</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E7E5E4]">
                  {transactions.map(t => (
                    <tr key={t.id} className="hover:bg-[#FAFAF9] transition-all">
                      <td className="px-6 py-5 text-sm text-[#57534E]">
                        {new Date(t.date).toLocaleString('pt-BR')}
                      </td>
                      <td className="px-6 py-5 font-bold">{t.item_name}</td>
                      <td className="px-6 py-5">
                        <span className={`inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider ${t.type === 'entry' ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}>
                          {t.type === 'entry' ? <ArrowDownLeft size={14} /> : <ArrowUpRight size={14} />}
                          {t.type === 'entry' ? 'Entrada' : 'Saída'}
                        </span>
                      </td>
                      <td className="px-6 py-5 text-sm font-medium text-[#78716C]">
                        {t.sector || '---'}
                      </td>
                      <td className="px-6 py-5 text-right font-bold text-lg">
                        {t.quantity}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {transactions.length === 0 && (
                <div className="p-20 text-center">
                  <History className="mx-auto text-[#E7E5E4] mb-4" size={48} />
                  <p className="text-[#78716C]">Nenhuma movimentação registrada.</p>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Modals */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-6">
          <motion.div 
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="bg-white w-full max-w-md rounded-3xl p-8 shadow-2xl"
          >
            <h3 className="text-2xl font-bold mb-6">Cadastrar Novo Item</h3>
            <form onSubmit={handleAddItem} className="space-y-4">
              <div>
                <label className="block text-sm font-bold text-[#57534E] mb-1">Nome do Item</label>
                <input 
                  required
                  list="item-suggestions"
                  type="text" 
                  className="w-full px-4 py-3 bg-[#F5F5F4] border-none rounded-xl focus:ring-2 focus:ring-[#1C1917]/10"
                  value={newItem.name}
                  onChange={e => setNewItem({...newItem, name: e.target.value})}
                  placeholder="Digite o nome do item..."
                />
                <datalist id="item-suggestions">
                  {items.map(item => (
                    <option key={item.id} value={item.name} />
                  ))}
                </datalist>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-bold text-[#57534E] mb-1">Quantidade Recebida</label>
                  <input 
                    required
                    type="number" 
                    min="1"
                    className="w-full px-4 py-3 bg-[#F5F5F4] border-none rounded-xl focus:ring-2 focus:ring-[#1C1917]/10"
                    value={isNaN(newItem.initial_quantity) ? '' : newItem.initial_quantity}
                    onChange={e => setNewItem({...newItem, initial_quantity: e.target.value === '' ? NaN : parseInt(e.target.value)})}
                  />
                </div>
                <div>
                  <label className="block text-sm font-bold text-[#57534E] mb-1">Estoque Mínimo (Alerta)</label>
                  <input 
                    required
                    type="number" 
                    min="0"
                    className="w-full px-4 py-3 bg-[#F5F5F4] border-none rounded-xl focus:ring-2 focus:ring-[#1C1917]/10"
                    value={isNaN(newItem.min_quantity) ? '' : newItem.min_quantity}
                    onChange={e => setNewItem({...newItem, min_quantity: e.target.value === '' ? NaN : parseInt(e.target.value)})}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-bold text-[#57534E] mb-1">Lote</label>
                  <input 
                    type="text" 
                    placeholder="Nº do Lote"
                    className="w-full px-4 py-3 bg-[#F5F5F4] border-none rounded-xl focus:ring-2 focus:ring-[#1C1917]/10"
                    value={newItem.batch_number}
                    onChange={e => setNewItem({...newItem, batch_number: e.target.value})}
                  />
                </div>
                <div>
                  <label className="block text-sm font-bold text-[#57534E] mb-1">Data de Validade</label>
                  <input 
                    type="date" 
                    className="w-full px-4 py-3 bg-[#F5F5F4] border-none rounded-xl focus:ring-2 focus:ring-[#1C1917]/10"
                    value={newItem.expiry_date}
                    onChange={e => setNewItem({...newItem, expiry_date: e.target.value})}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-bold text-[#57534E] mb-1">Tipo de Item</label>
                  <select 
                    className="w-full px-4 py-3 bg-[#F5F5F4] border-none rounded-xl focus:ring-2 focus:ring-[#1C1917]/10"
                    value={newItem.category}
                    onChange={e => setNewItem({...newItem, category: e.target.value})}
                  >
                    <option value="Médico Hospitalar">Médico Hospitalar</option>
                    <option value="Alimentício">Alimentício</option>
                    <option value="Expediente">Expediente</option>
                    <option value="Higiene">Higiene</option>
                    <option value="Radiológico">Radiológico</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-bold text-[#57534E] mb-1">Fornecedor</label>
                  <input 
                    type="text" 
                    placeholder="Nome do fornecedor"
                    className="w-full px-4 py-3 bg-[#F5F5F4] border-none rounded-xl focus:ring-2 focus:ring-[#1C1917]/10"
                    value={newItem.supplier}
                    onChange={e => setNewItem({...newItem, supplier: e.target.value})}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-bold text-[#57534E] mb-1">Origem</label>
                  <select 
                    className="w-full px-4 py-3 bg-[#F5F5F4] border-none rounded-xl focus:ring-2 focus:ring-[#1C1917]/10"
                    value={newItem.origin}
                    onChange={e => setNewItem({...newItem, origin: e.target.value as 'contract' | 'extra'})}
                  >
                    <option value="contract">Contrato</option>
                    <option value="extra">Produto Extra</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-bold text-[#57534E] mb-1">Valor Unitário (R$)</label>
                  <input 
                    type="number" 
                    step="0.01"
                    placeholder="0,00"
                    className="w-full px-4 py-3 bg-[#F5F5F4] border-none rounded-xl focus:ring-2 focus:ring-[#1C1917]/10"
                    value={isNaN(newItem.unit_price) ? '' : newItem.unit_price}
                    onChange={e => setNewItem({...newItem, unit_price: e.target.value === '' ? NaN : parseFloat(e.target.value)})}
                  />
                </div>
              </div>
              <div className="flex gap-3 pt-4">
                <button 
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="flex-1 px-4 py-3 rounded-xl font-bold text-[#78716C] hover:bg-[#F5F5F4] transition-all"
                >
                  Cancelar
                </button>
                <button 
                  type="submit"
                  className="flex-1 px-4 py-3 bg-[#1C1917] text-white rounded-xl font-bold hover:bg-[#292524] transition-all"
                >
                  Salvar
                </button>
              </div>
            </form>
          </motion.div>
        </div>
      )}

      {showTransactionModal.show && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-6">
          <motion.div 
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="bg-white w-full max-w-lg rounded-3xl p-8 shadow-2xl max-h-[90vh] overflow-y-auto"
          >
            <h3 className="text-2xl font-bold mb-6">
              {showTransactionModal.type === 'entry' ? 'Registrar Entrada' : 'Registrar Saída'}
            </h3>
            
            <form onSubmit={handleTransaction} className="space-y-6">
              {showTransactionModal.type === 'entry' ? (
                <>
                  {showTransactionModal.item ? (
                    <div className="mb-6">
                      <p className="text-[#78716C] font-medium">{showTransactionModal.item.name}</p>
                      <p className="text-xs font-bold text-emerald-600 mt-1">
                        Disponível em estoque: {showTransactionModal.item.quantity} unidades
                      </p>
                    </div>
                  ) : (
                    <div className="mb-6">
                      <label className="block text-sm font-bold text-[#57534E] mb-2">Selecionar Item</label>
                      <select 
                        required
                        className="w-full px-4 py-3 bg-[#F5F5F4] border-none rounded-xl focus:ring-2 focus:ring-[#1C1917]/10"
                        value={selectedItemId}
                        onChange={e => setSelectedItemId(Number(e.target.value))}
                      >
                        <option value="">Selecione um item...</option>
                        {items.map(item => (
                          <option key={item.id} value={item.id}>
                            {item.name} (Lote: {item.batch_number || 'N/A'}) - {item.quantity} un.
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  <div>
                    <label className="block text-sm font-bold text-[#57534E] mb-2 text-center">Quantidade</label>
                    <div className="flex items-center justify-center gap-6">
                      <button 
                        type="button"
                        onClick={() => setTransactionQty(Math.max(1, transactionQty - 1))}
                        className="w-12 h-12 rounded-2xl bg-[#F5F5F4] flex items-center justify-center text-2xl font-bold hover:bg-[#E7E5E4]"
                      >
                        -
                      </button>
                      <span className="text-4xl font-bold w-16 text-center">{transactionQty}</span>
                      <button 
                        type="button"
                        onClick={() => setTransactionQty(transactionQty + 1)}
                        className="w-12 h-12 rounded-2xl bg-[#F5F5F4] flex items-center justify-center text-2xl font-bold hover:bg-[#E7E5E4]"
                      >
                        +
                      </button>
                    </div>
                  </div>
                </>
              ) : (
                <div className="space-y-6">
                  <div>
                    <label className="block text-sm font-bold text-[#57534E] mb-2">Setor de Destino</label>
                    <select 
                      required
                      className="w-full px-4 py-3 bg-[#F5F5F4] border-none rounded-xl focus:ring-2 focus:ring-[#1C1917]/10"
                      value={selectedSector}
                      onChange={e => setSelectedSector(e.target.value)}
                    >
                      {SECTORS.map(sector => (
                        <option key={sector} value={sector}>{sector}</option>
                      ))}
                    </select>
                  </div>

                  <div className="space-y-4">
                    <label className="block text-sm font-bold text-[#57534E]">Itens para Saída</label>
                    {basket.map((b, index) => {
                      const item = items.find(i => i.id === b.item_id);
                      return (
                        <div key={index} className="flex items-center gap-4 bg-[#F5F5F4] p-4 rounded-2xl">
                          <div className="flex-1">
                            <p className="font-bold text-sm">{item?.name || 'Item não encontrado'}</p>
                            <p className="text-[10px] text-[#78716C]">Lote: {item?.batch_number || 'N/A'} | Estoque: {item?.quantity || 0}</p>
                          </div>
                          <div className="flex items-center gap-3">
                            <button 
                              type="button"
                              onClick={() => {
                                const newBasket = [...basket];
                                newBasket[index].quantity = Math.max(1, newBasket[index].quantity - 1);
                                setBasket(newBasket);
                              }}
                              className="w-8 h-8 rounded-lg bg-white flex items-center justify-center font-bold hover:bg-gray-100"
                            >
                              -
                            </button>
                            <span className="font-bold w-6 text-center">{b.quantity}</span>
                            <button 
                              type="button"
                              onClick={() => {
                                const newBasket = [...basket];
                                newBasket[index].quantity = Math.min(item?.quantity || 999, newBasket[index].quantity + 1);
                                setBasket(newBasket);
                              }}
                              className="w-8 h-8 rounded-lg bg-white flex items-center justify-center font-bold hover:bg-gray-100"
                            >
                              +
                            </button>
                            <button 
                              type="button"
                              onClick={() => setBasket(basket.filter((_, i) => i !== index))}
                              className="text-rose-500 hover:text-rose-700 ml-2"
                            >
                              <X size={18} />
                            </button>
                          </div>
                        </div>
                      );
                    })}

                    <div className="space-y-4">
                      <div className="flex gap-2">
                        <div className="flex-1">
                          <label className="block text-[10px] font-bold text-[#A8A29E] uppercase mb-1 ml-1">1. Escolha o Item</label>
                          <select 
                            className="w-full px-4 py-3 bg-[#F5F5F4] border-none rounded-xl text-sm focus:ring-2 focus:ring-[#1C1917]/10"
                            value={selectedItemName}
                            onChange={e => {
                              setSelectedItemName(e.target.value);
                              setSelectedItemId('');
                            }}
                          >
                            <option value="">Selecione um item...</option>
                            {(Array.from(new Set(items.filter(i => i.quantity > 0).map(i => i.name))) as string[])
                              .sort((a, b) => a.localeCompare(b))
                              .map(name => (
                                <option key={name} value={name}>{name}</option>
                              ))
                            }
                          </select>
                        </div>

                        {selectedItemName && (
                          <div className="flex-1">
                            <label className="block text-[10px] font-bold text-[#A8A29E] uppercase mb-1 ml-1">2. Escolha o Lote</label>
                            <select 
                              className="w-full px-4 py-3 bg-[#F5F5F4] border-none rounded-xl text-sm focus:ring-2 focus:ring-[#1C1917]/10"
                              value={selectedItemId}
                              onChange={e => {
                                const id = Number(e.target.value);
                                if (!id) return;
                                if (basket.some(b => b.item_id === id)) {
                                  alert('Este lote já está na lista de saída.');
                                  return;
                                }
                                setBasket([...basket, { item_id: id, quantity: 1 }]);
                                setSelectedItemId('');
                                setSelectedItemName('');
                              }}
                            >
                              <option value="">Selecione o lote...</option>
                              {items
                                .filter(i => i.name === selectedItemName && i.quantity > 0 && !basket.some(b => b.item_id === i.id))
                                .map(item => (
                                  <option key={item.id} value={item.id}>
                                    Lote: {item.batch_number || 'S/N'} ({item.quantity} un.) {item.expiry_date ? `- Venc: ${new Date(item.expiry_date).toLocaleDateString('pt-BR')}` : ''}
                                  </option>
                                ))
                              }
                            </select>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              )}
              
              <div className="flex gap-3 pt-4">
                <button 
                  type="button"
                  onClick={() => setShowTransactionModal({ show: false, type: 'entry' })}
                  className="flex-1 px-4 py-3 rounded-xl font-bold text-[#78716C] hover:bg-[#F5F5F4] transition-all"
                >
                  Cancelar
                </button>
                <button 
                  type="submit"
                  disabled={showTransactionModal.type === 'exit' && basket.length === 0}
                  className={`flex-1 px-4 py-3 text-white rounded-xl font-bold transition-all disabled:opacity-50 ${showTransactionModal.type === 'entry' ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-rose-600 hover:bg-rose-700'}`}
                >
                  Confirmar {showTransactionModal.type === 'exit' && basket.length > 0 && `(${basket.length})`}
                </button>
              </div>
            </form>
          </motion.div>
        </div>
      )}

      {showDetailModal.show && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-6">
          <motion.div 
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="bg-white w-full max-w-2xl rounded-3xl p-8 shadow-2xl max-h-[80vh] overflow-y-auto"
          >
            <div className="flex justify-between items-center mb-6">
              <h3 className="text-2xl font-bold">
                {showDetailModal.type === 'low_stock' ? 'Itens com Estoque Baixo' : 'Itens com Vencimento Próximo'}
              </h3>
              <button 
                onClick={() => setShowDetailModal({ show: false, type: 'low_stock', items: [] })}
                className="p-2 hover:bg-[#F5F5F4] rounded-full transition-all"
              >
                <X size={24} />
              </button>
            </div>

            <div className="space-y-4">
              {showDetailModal.items.map(item => (
                <div 
                  key={`modal-${item.id}`} 
                  className={`flex items-center justify-between p-5 rounded-2xl border ${showDetailModal.type === 'low_stock' ? 'bg-orange-50 border-orange-100' : 'bg-red-50 border-red-100'}`}
                >
                  <div className="flex items-center gap-4">
                    <div className={`w-12 h-12 rounded-full flex items-center justify-center font-bold ${showDetailModal.type === 'low_stock' ? 'bg-orange-200 text-orange-700' : 'bg-red-200 text-red-700'}`}>
                      {showDetailModal.type === 'low_stock' ? item.quantity : <Calendar size={20} />}
                    </div>
                    <div>
                      <p className="font-bold text-lg">{item.name}</p>
                      <p className={`text-sm ${showDetailModal.type === 'low_stock' ? 'text-orange-700' : 'text-red-700'}`}>
                        {showDetailModal.type === 'low_stock' 
                          ? `Estoque atual: ${item.quantity} (Mínimo: ${item.min_quantity})` 
                          : `Vencimento: ${new Date(item.expiry_date!).toLocaleDateString('pt-BR')}`}
                      </p>
                      <p className="text-xs text-[#78716C] mt-1">Lote: {item.batch_number || 'N/A'} | Fornecedor: {item.supplier || 'N/A'}</p>
                    </div>
                  </div>
                  <button 
                    onClick={() => {
                      setShowDetailModal({ show: false, type: 'low_stock', items: [] });
                      setShowTransactionModal({ show: true, type: showDetailModal.type === 'low_stock' ? 'entry' : 'exit', item });
                    }}
                    className={`px-5 py-2 rounded-xl text-sm font-bold text-white transition-all ${showDetailModal.type === 'low_stock' ? 'bg-orange-600 hover:bg-orange-700' : 'bg-red-600 hover:bg-red-700'}`}
                  >
                    {showDetailModal.type === 'low_stock' ? 'Repor' : 'Retirar'}
                  </button>
                </div>
              ))}
            </div>
          </motion.div>
        </div>
      )}
    </div>
  );
}
