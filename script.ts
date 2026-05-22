import { 
    collection, 
    doc, 
    setDoc, 
    getDoc, 
    getDocs, 
    updateDoc, 
    deleteDoc, 
    query, 
    where, 
    orderBy, 
    onSnapshot,
    serverTimestamp,
    Timestamp 
} from 'firebase/firestore';
import { 
    signInWithEmailAndPassword, 
    createUserWithEmailAndPassword, 
    signOut, 
    onAuthStateChanged,
    updatePassword,
    sendPasswordResetEmail,
    confirmPasswordReset,
    verifyPasswordResetCode,
    reauthenticateWithCredential,
    EmailAuthProvider
} from 'firebase/auth';
import { db, auth } from './firebase-init';

declare const d3: any;

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as any)?.code;

  let friendlyMessage = message;
  if (code === 'unavailable' || code === 'auth/network-request-failed') {
    friendlyMessage = "❌ Cannot connect to Firebase! \n\n1. Ensure you have an active internet connection.\n2. In Firebase Console (Authentication > Settings), add this domain to 'Authorized Domains': \n   " + window.location.hostname + "\n3. Ensure you have created a 'Firestore Database' in the console.";
  } else if (code === 'permission-denied') {
    friendlyMessage = "❌ Permission Denied! Check your Firestore Security Rules.";
  }

  const errInfo: FirestoreErrorInfo = {
    error: friendlyMessage,
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData?.map(provider => ({
        providerId: provider.providerId,
        email: provider.email,
      })) || []
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  
  // Show a visible alert if unreachable
  if (code === 'unavailable') {
    showStatusNotification(friendlyMessage, 'error');
  }

  throw new Error(JSON.stringify(errInfo));
}

async function testFirestoreConnection() {
  try {
    // Try to get a dummy document to wake up the connection
    await getDoc(doc(db, '_connection_test', 'ping'));
    console.log("Firestore connection check: OK");
  } catch (error: any) {
    if (error.code === 'unavailable' || error.code === 'auth/network-request-failed') {
        const msg = "❌ Cloud Firestore is unreachable. \n- Please add " + window.location.hostname + " to 'Authorized Domains' in the Firebase Console (Authentication > Settings).";
        console.error(msg);
        showStatusNotification(msg, 'error');
    }
  }
}

const KEYS = {
    USERS: 'spendwise_users',
    SESSION: 'spendwise_session'
};

// State
let transactions: any[] = [];
let budgets: Record<string, number> = {};
let editId: string | null = null;
let transactionToDeleteId: string | null = null;
let unsubTransactions: (() => void) | null = null;
let unsubBudgets: (() => void) | null = null;
let currentUserProfile: any = null;
let isAuthInitialized = false;

const CATEGORIES = ["Food", "Salary", "Rent", "Shopping", "Health", "Travel", "Education", "Other"];
const CATEGORY_ICONS = {
    "Food": "🍔",
    "Salary": "💰",
    "Rent": "🏠",
    "Shopping": "🛍️",
    "Health": "🏥",
    "Travel": "✈️",
    "Education": "🎓",
    "Other": "✨"
};

const getCategoryIcon = (cat: string) => (CATEGORY_ICONS as Record<string, string>)[cat] || "❓";

// --- Persistence ---
// Removed localStorage persistence in favor of Firebase Real-time listeners

function setupRealtimeListeners(user) {
    if (!user) {
        if (unsubTransactions) unsubTransactions();
        if (unsubBudgets) unsubBudgets();
        transactions = [];
        budgets = {};
        return;
    }

    const transactionsRef = collection(db, 'users', user.uid, 'transactions');
    const budgetsRef = collection(db, 'users', user.uid, 'budgets');

    // Listener for Transactions
    unsubTransactions = onSnapshot(query(transactionsRef, orderBy('date', 'desc')), (snapshot) => {
        transactions = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        // Use requestAnimationFrame for smoother UI updates
        requestAnimationFrame(() => refreshUI());
    }, (error) => {
        handleFirestoreError(error, OperationType.LIST, `users/${user.uid}/transactions`);
    });

    // Listener for Budgets
    unsubBudgets = onSnapshot(budgetsRef, (snapshot) => {
        const newBudgets = {};
        snapshot.docs.forEach(doc => {
            newBudgets[doc.id] = doc.data().amount;
        });
        budgets = newBudgets;
        requestAnimationFrame(() => refreshUI());
    }, (error) => {
        handleFirestoreError(error, OperationType.LIST, `users/${user.uid}/budgets`);
    });
}

function stopRealtimeListeners() {
    if (unsubTransactions) unsubTransactions();
    if (unsubBudgets) unsubBudgets();
}

// --- Combined Search & Filter ---
function applySearchAndFilter(pageType = 'dashboard') {
    let qId = "search";
    let fId = "filter";
    
    if (pageType === 'history') {
        qId = "searchHistory";
        fId = "filterHistory";
    }
    
    const q = (document.getElementById(qId) as HTMLInputElement)?.value.toLowerCase() || "";
    const f = (document.getElementById(fId) as HTMLSelectElement)?.value || "all";

    // Only show active transactions on dashboard
    let data = transactions.filter(t => t.status === 'active');

    if (f !== "all") {
        data = data.filter(t => t.type === f);
    }

    if (q) {
        data = data.filter(t =>
            t.description.toLowerCase().includes(q) ||
            t.category.toLowerCase().includes(q)
        );
    }

    return data; // Already sorted by Firestore query
}

// --- UI Components ---
function updateTotals(filteredData: any[]) {
    const income = filteredData
        .filter(t => t.type === 'income')
        .reduce((sum, t) => sum + parseFloat(t.amount || 0), 0);
    
    const expense = filteredData
        .filter(t => t.type === 'expense')
        .reduce((sum, t) => sum + parseFloat(t.amount || 0), 0);
    
    const balance = income - expense;

    const fmt = (v: number) => `₹ ${Math.round(v).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
    
    const bEl = document.getElementById('balance') || document.getElementById('totalBalance');
    const iEl = document.getElementById('income') || document.getElementById('totalIncome');
    const eEl = document.getElementById('expense') || document.getElementById('totalExpense');

    if (bEl) {
        if (balance < 0) {
            bEl.textContent = fmt(balance) + ' ⚠️';
            (bEl as HTMLElement).style.color = 'var(--danger)';
        } else {
            bEl.textContent = fmt(balance);
            (bEl as HTMLElement).style.color = '';
        }
    }
    if (iEl) iEl.textContent = fmt(income);
    if (eEl) eEl.textContent = fmt(expense);
}

function renderTransactions(data: any[], readOnly = false, listId = 'transactionList') {
    const list = document.getElementById(listId);
    if (!list) return;

    if (data.length === 0) {
        list.innerHTML = `<div class="empty-state">No transactions available</div>`;
        return;
    }

    list.innerHTML = data.map(t => `
        <div class="item ${editId === t.id ? 'editing' : ''}">
            <div class="item-info">
                <div class="icon ${t.type === 'income' ? 'income-icon' : 'expense-icon'}">
                    ${t.type === 'income' ? '↑' : '↓'}
                </div>
                <div class="item-details">
                    <h3>${t.description}</h3>
                    <p>
                        ${new Date(t.date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
                    </p>
                    <div class="badges">
                        <span class="badge ${t.type}">${t.type}</span>
                        <span class="badge category">${getCategoryIcon(t.category)} ${t.category}</span>
                    </div>
                </div>
            </div>
            <div class="item-right">
                <div class="amount ${t.type === 'income' ? 'income-icon' : 'expense-icon'}">
                    ${t.type === 'income' ? '+' : '-'} ₹${Math.round(Math.abs(t.amount)).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                </div>
                ${!readOnly ? `
                <div class="actions">
                    <button class="action-btn edit-btn" onclick="editTransaction('${t.id}')" title="Edit" aria-label="Edit transaction ${t.description}">✏️</button>
                    <button class="action-btn delete-btn" onclick="deleteTransaction('${t.id}')" title="Delete" aria-label="Delete transaction ${t.description}">🗑️</button>
                </div>
                ` : ''}
            </div>
        </div>
    `).join('');
}



function getFilteredHistory() {
    const historySearchQ = (document.getElementById('searchHistory') as HTMLInputElement)?.value.toLowerCase() || "";
    const historyTypeF = (document.getElementById('filterHistory') as HTMLSelectElement)?.value || "all";

    const combinedHistory = [...transactions]; 

    return combinedHistory.filter(t => {
        const matchesSearch = t.description.toLowerCase().includes(historySearchQ) || 
                             t.category.toLowerCase().includes(historySearchQ);
        const matchesType = historyTypeF === "all" || t.type === historyTypeF;
        return matchesSearch && matchesType;
    });
}

function refreshUI() {
    const path = window.location.pathname.toLowerCase();
    const isHistoryPage = path.includes('history.html');
    
    if (isHistoryPage) {
        const filteredData = applySearchAndFilter('history');
        renderTransactions(filteredData, false, 'transactionListHistory');
    } else {
        const filteredData = applySearchAndFilter('dashboard');
        renderTransactions(filteredData, false, 'transactionList');
        updateTotals(filteredData);
        if (typeof updateCategoryBreakdown === 'function') updateCategoryBreakdown(filteredData);
        if (typeof renderMonthlySummary === 'function') renderMonthlySummary(filteredData);
        if (typeof updateBudgetDisplay === 'function') updateBudgetDisplay(filteredData);
    }

    // Toggle reset button visibility for current context
    const qId = isHistoryPage ? 'searchHistory' : 'search';
    const fId = isHistoryPage ? 'filterHistory' : 'filter';
    
    const q = (document.getElementById(qId) as HTMLInputElement)?.value || "";
    const f = (document.getElementById(fId) as HTMLSelectElement)?.value || "all";
    const isFiltered = (q !== "" || f !== "all");
    
    const resetBtn = document.getElementById('resetFilterBtn');
    if (resetBtn) resetBtn.style.display = isFiltered && !isHistoryPage ? 'block' : 'none';

    const resetBtnHistory = document.getElementById('resetFilterBtnHistory');
    if (resetBtnHistory) resetBtnHistory.style.display = isFiltered && isHistoryPage ? 'block' : 'none';
    
    const floatContainer = document.getElementById('floatingResetContainer');
    if (floatContainer) {
        if (isFiltered) floatContainer.classList.add('visible');
        else floatContainer.classList.remove('visible');
    }

    // History Table
    const filteredHistory = getFilteredHistory();
    renderHistoryTable(filteredHistory); 
    renderTrashTable(); 
}

function updateCategoryBreakdown(data) {
    const container = document.getElementById('bar-chart-container');
    if (!container) return;
    
    let incomeTotal = 0;
    let expenseTotal = 0;

    data.forEach(t => {
        if (t.type === 'income') incomeTotal += parseFloat(t.amount || 0);
        else expenseTotal += parseFloat(t.amount || 0);
    });

    const plotData = [
        { label: 'Income', value: incomeTotal, type: 'income', color: '#22c55e', gradStart: '#10b981', gradEnd: '#059669' },
        { label: 'Expense', value: expenseTotal, type: 'expense', color: '#ef4444', gradStart: '#f87171', gradEnd: '#dc2626' }
    ];

    container.innerHTML = '';

    if (incomeTotal === 0 && expenseTotal === 0) {
        container.innerHTML = '<div style="color: var(--text-muted); font-size: 0.9rem;">Add some data to see the overview</div>';
        return;
    }

    const width = container.offsetWidth;
    const height = 320;
    const margin = { top: 30, right: 40, bottom: 60, left: 40 };

    const svg = d3.select("#bar-chart-container")
        .append("svg")
        .attr("width", width)
        .attr("height", height)
        .attr("viewBox", `0 0 ${width} ${height}`)
        .attr("preserveAspectRatio", "xMidYMid meet")
        .style("overflow", "visible");

    // Definitions for Gradients and Filters
    const defs = svg.append("defs");

    // Gradients
    plotData.forEach((d, i) => {
        const gradient = defs.append("linearGradient")
            .attr("id", `bar-grad-${i}`)
            .attr("x1", "0%")
            .attr("y1", "0%")
            .attr("x2", "0%")
            .attr("y2", "100%");

        gradient.append("stop")
            .attr("offset", "0%")
            .attr("stop-color", d.gradStart);

        gradient.append("stop")
            .attr("offset", "100%")
            .attr("stop-color", d.gradEnd);
    });

    // Glow Filter
    const glowFilter = defs.append("filter")
        .attr("id", "bar-glow")
        .attr("x", "-50%")
        .attr("y", "-50%")
        .attr("width", "200%")
        .attr("height", "200%");

    glowFilter.append("feGaussianBlur")
        .attr("stdDeviation", "5")
        .attr("result", "blur");
    glowFilter.append("feComposite")
        .attr("in", "SourceGraphic")
        .attr("in2", "blur")
        .attr("operator", "over");

    const innerWidth = width - margin.left - margin.right;
    const innerHeight = height - margin.top - margin.bottom;

    const chartG = svg.append("g")
        .attr("transform", `translate(${margin.left},${margin.top})`);

    // Handle Tooltip (ensure single instance)
    let tooltip = d3.select("body > .chart-tooltip");
    if (tooltip.empty()) {
        tooltip = d3.select("body").append("div")
            .attr("class", "chart-tooltip")
            .style("position", "absolute")
            .style("visibility", "hidden")
            .style("background", "rgba(0, 0, 0, 0.95)")
            .style("color", "#fff")
            .style("padding", "12px 16px")
            .style("border-radius", "12px")
            .style("font-size", "13px")
            .style("pointer-events", "none")
            .style("box-shadow", "0 10px 25px rgba(0,0,0,0.5)")
            .style("border", "1px solid rgba(212, 175, 55, 0.3)")
            .style("z-index", "1000")
            .style("transition", "opacity 0.2s ease");
    }

    const x = d3.scaleBand()
        .range([0, innerWidth])
        .domain(plotData.map(d => d.label))
        .padding(0.5);

    const y = d3.scaleLinear()
        .domain([0, d3.max(plotData, d => d.value) * 1.2 || 1000])
        .range([innerHeight, 0]);

    // Y Axis Label (Amount)
    chartG.append("text")
        .attr("transform", "rotate(-90)")
        .attr("y", -margin.left + 15)
        .attr("x", -innerHeight / 2)
        .attr("text-anchor", "middle")
        .style("fill", "rgba(255,255,255,0.4)")
        .style("font-size", "11px")
        .style("text-transform", "uppercase")
        .style("letter-spacing", "1px")
        .text("Total Value (₹)");

    // Grid lines
    chartG.append("g")
        .attr("class", "grid")
        .style("stroke", "rgba(255,255,255,0.05)")
        .style("stroke-dasharray", "3,3")
        .call(d3.axisLeft(y)
            .ticks(5)
            .tickSize(-innerWidth)
            .tickFormat("")
        );

    // Bars
    chartG.selectAll("rect.bar")
        .data(plotData)
        .enter()
        .append("rect")
        .attr("class", "bar")
        .attr("x", d => x(d.label))
        .attr("width", x.bandwidth())
        .attr("y", innerHeight) // Start at bottom for animation
        .attr("height", 0)       // Start with 0 height for animation
        .attr("fill", (d, i) => `url(#bar-grad-${i})`)
        .attr("rx", 10)
        .attr("ry", 10)
        .style("cursor", "pointer")
        .style("filter", "drop-shadow(0px 8px 15px rgba(0,0,0,0.4))")
        .on("mouseenter", function(event: MouseEvent, d: any) {
            d3.select(event.currentTarget)
                .transition()
                .duration(200)
                .attr("fill-opacity", 0.9)
                .style("filter", "url(#bar-glow) drop-shadow(0px 10px 20px rgba(0,0,0,0.5))");
            
            tooltip.style("visibility", "visible")
                .html(`
                    <div style="font-weight: 700; color: ${d.color}; margin-bottom: 4px;">${d.label} Overview</div>
                    <div style="font-size: 16px; font-weight: 800;">₹${Math.round(d.value).toLocaleString('en-IN', { maximumFractionDigits: 0 })}</div>
                    <div style="font-size: 11px; margin-top: 5px; color: rgba(255,255,255,0.6);">Click bar to filter log</div>
                `);
        })
        .on("mousemove", function(event) {
            tooltip.style("top", (event.pageY - 10) + "px")
                .style("left", (event.pageX + 15) + "px");
        })
        .on("mouseleave", function(event: MouseEvent, d: any) {
            d3.select(event.currentTarget)
                .transition()
                .duration(200)
                .attr("fill-opacity", 1)
                .style("filter", "drop-shadow(0px 8px 15px rgba(0,0,0,0.4))");
            
            tooltip.style("visibility", "hidden");
        })
        .on("click", (event, d) => {
            const filterEl = document.getElementById('filter') as HTMLSelectElement;
            const searchEl = document.getElementById('search') as HTMLInputElement;
            if (filterEl) {
                if (searchEl) searchEl.value = "";
                filterEl.value = d.type;
                refreshUI();
                
                // Scroll to transaction log
                const logSection = document.getElementById('historyTitle');
                if (logSection) {
                    logSection.scrollIntoView({ behavior: 'smooth' });
                }
                
                showStatusNotification(`Filtering log by: ${d.label}`, 'success');
            }
        })
        .transition() // Animation
        .duration(400) // Reduced from 1000 to eliminate perceived lag
        .ease(d3.easeCubicOut)
        .attr("y", d => y(d.value))
        .attr("height", d => innerHeight - y(d.value));

    // Value Labels
    chartG.selectAll(".bar-value")
        .data(plotData)
        .enter()
        .append("text")
        .attr("class", "bar-value")
        .attr("x", d => x(d.label) + x.bandwidth() / 2)
        .attr("y", innerHeight)
        .attr("text-anchor", "middle")
        .style("fill", "white")
        .style("font-size", "13px")
        .style("font-weight", "700")
        .style("opacity", 0)
        .style("pointer-events", "none")
        .text(d => `₹${Math.round(d.value).toLocaleString('en-IN')}`)
        .transition()
        .duration(400)
        .delay((d, i) => 200 + (i * 100))
        .attr("y", d => y(d.value) - 15)
        .style("opacity", 1);

    // Labels (Category names)
    chartG.selectAll("text.label")
        .data(plotData)
        .enter()
        .append("text")
        .attr("class", "label")
        .attr("x", d => x(d.label) + x.bandwidth() / 2)
        .attr("y", innerHeight + 35)
        .attr("text-anchor", "middle")
        .style("fill", d => d.color)
        .style("font-weight", "800")
        .style("font-size", "16px")
        .style("letter-spacing", "0.5px")
        .style("text-transform", "uppercase")
        .text(d => d.label)
        .style("opacity", 0)
        .transition()
        .duration(800)
        .delay(1000)
        .style("opacity", 1);
}

function renderMonthlySummary(data: any[]) {
    const container = document.getElementById('monthlySummaryList');
    if (!container) return;

    // Group by month
    const monthlyData: Record<string, { income: number; expense: number }> = {};
    data.forEach(t => {
        const dateObj = new Date(t.date);
        if (isNaN(dateObj.getTime())) return;
        const monthYear = dateObj.toLocaleString('en-GB', { month: 'long', year: 'numeric' });
        
        if (!monthlyData[monthYear]) {
            monthlyData[monthYear] = { income: 0, expense: 0 };
        }
        
        if (t.type === 'income') monthlyData[monthYear].income += parseFloat(t.amount);
        else monthlyData[monthYear].expense += parseFloat(t.amount);
    });

    const sortedMonths = Object.entries(monthlyData).sort((a, b) => new Date(b[0]).getTime() - new Date(a[0]).getTime());

    if (sortedMonths.length === 0) {
        container.innerHTML = '<div style="color: var(--text-muted); font-size: 0.9rem;">No data for monthly summary</div>';
        return;
    }

    container.innerHTML = sortedMonths.map(([month, totals]) => `
        <div class="monthly-item shadow-hover">
            <div class="monthly-item-left">
                <div style="font-size: 0.8rem; text-transform: uppercase; letter-spacing: 2px; color: var(--primary); font-weight: 700;">Financial Period</div>
                <div class="monthly-month-name">${month}</div>
                <div style="font-size: 2rem; margin-top: 10px; opacity: 0.2; position: absolute; left: 10px; bottom: -5px; pointer-events: none;">📊</div>
            </div>
            <div class="monthly-item-right">
                <div class="summary-value" style="color: var(--success); font-size: 0.9rem;">
                    <span style="opacity: 0.6; margin-right: 5px;">Income</span> 
                    ₹${Math.round(totals.income).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                </div>
                <div class="summary-value" style="color: var(--danger); font-size: 0.9rem;">
                    <span style="opacity: 0.6; margin-right: 5px;">Expense</span> 
                    ₹${Math.round(totals.expense).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                </div>
                <div class="summary-net" style="color: ${totals.income >= totals.expense ? 'var(--success)' : 'var(--danger)'}">
                    <span style="font-size: 0.75rem; vertical-align: middle; opacity: 0.7; margin-right: 5px;">NET SAVINGS</span>
                    ₹${Math.round(totals.income - totals.expense).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                </div>
            </div>
        </div>
    `).join('');
}


function updateBudgetDisplay(data: any[]) {
    const container = document.getElementById('budgetDisplayList');
    if (!container) return;

    // Only look at current month
    const now = new Date();
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();

    const spendingByCategory: Record<string, number> = {};
    CATEGORIES.forEach(cat => spendingByCategory[cat] = 0);

    data.forEach(t => {
        if (t.type === 'expense') {
            const tDate = new Date(t.date);
            if (tDate.getMonth() === currentMonth && tDate.getFullYear() === currentYear) {
                if (spendingByCategory[t.category] !== undefined) {
                    spendingByCategory[t.category] += parseFloat(t.amount);
                }
            }
        }
    });

    const activeBudgets = Object.entries(budgets).filter(([cat, amount]) => amount > 0);

    if (activeBudgets.length === 0) {
        container.innerHTML = `
            <div style="text-align: center; padding: 20px; color: var(--text-muted); font-size: 0.9rem;">
                No budgets set. Click "Manage Budgets" to track your limits.
            </div>
        `;
        return;
    }

    container.innerHTML = activeBudgets.map(([cat, amountLimit]) => {
        const limit = amountLimit as number;
        const spent = spendingByCategory[cat] || 0;
        const percentage = Math.min((spent / limit) * 100, 100);
        let statusClass = 'safe';
        if (percentage >= 100) statusClass = 'danger';
        else if (percentage >= 80) statusClass = 'warning';

        return `
            <div class="budget-item">
                <div class="budget-item-header">
                    <span class="budget-category">${getCategoryIcon(cat)} ${cat}</span>
                    <span class="budget-amount">₹${Math.round(spent).toLocaleString('en-IN')} / ₹${Math.round(limit).toLocaleString('en-IN')}</span>
                </div>
                <div class="progress-bar-container">
                    <div class="progress-bar-fill ${statusClass}" style="width: ${percentage}%"></div>
                </div>
                <div class="budget-percentage" style="color: ${percentage >= 100 ? 'var(--danger)' : 'var(--text-muted)'}">
                    ${Math.round(spent / limit * 100)}%
                </div>
            </div>
        `;
    }).join('');
}

function populateBudgetFields() {
    const container = document.getElementById('budgetFieldsContainer');
    if (!container) return;

    container.innerHTML = CATEGORIES.map(cat => {
        // Exclude Salary from budget if it's strictly an income category
        if (cat === 'Salary') return '';
        
        return `
            <div class="form-group" style="margin-bottom: 15px;">
                <label style="color: white; font-size: 0.8rem;">${getCategoryIcon(cat)} ${cat} Budget (₹)</label>
                <input type="number" step="1" placeholder="0" data-category="${cat}" value="${budgets[cat] || ''}" class="budget-input">
            </div>
        `;
    }).join('');
}


function renderTrashTable() {
    const tbody = document.getElementById('trashTableBody');
    if (!tbody) return;

    const deletedItems = transactions.filter(t => t.status === 'deleted');

    if (deletedItems.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; padding: 40px; color: var(--text-muted);">Trash is empty</td></tr>`;
        return;
    }

    tbody.innerHTML = deletedItems.map(t => `
        <tr>
            <td>${new Date(t.date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}</td>
            <td>${t.description}</td>
            <td class="${t.type}">₹${Math.round(Math.abs(t.amount)).toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
            <td style="text-align: right;">
                <button class="btn btn-sm btn-outline" style="border-color: var(--success); color: var(--success); margin-right: 5px;" onclick="window.restoreTransaction('${t.id}')">Restore</button>
                <button class="btn btn-sm btn-outline" style="border-color: var(--danger); color: var(--danger);" onclick="window.permanentlyDelete('${t.id}')">Delete</button>
            </td>
        </tr>
    `).join('');
}

(window as any).restoreTransaction = async (id: string) => {
    if (!auth.currentUser) return;
    const path = `users/${auth.currentUser.uid}/transactions/${id}`;
    try {
        await updateDoc(doc(db, path), {
            status: 'active',
            updatedAt: serverTimestamp()
        });
        showStatusNotification("Transaction restored", "success");
    } catch (error) {
        handleFirestoreError(error, OperationType.UPDATE, path);
    }
};

(window as any).permanentlyDelete = async (id: string) => {
    if (!auth.currentUser) return;
    const path = `users/${auth.currentUser.uid}/transactions/${id}`;
    try {
        await deleteDoc(doc(db, path));
        showStatusNotification("Permanently removed", "error");
    } catch (error) {
        handleFirestoreError(error, OperationType.DELETE, path);
    }
};

function renderHistoryTable(data: any[]) {
    const tbody = document.getElementById('historyTableBody');
    if (!tbody) return;

    if (data.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 40px; color: var(--text-muted);">No data to display</td></tr>`;
        return;
    }

    tbody.innerHTML = data.map(t => `
        <tr style="${t.status === 'deleted' ? 'opacity: 0.6; background: rgba(239, 68, 68, 0.05);' : ''}">
            <td>${new Date(t.date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}</td>
            <td style="${t.status === 'deleted' ? 'text-decoration: line-through;' : ''}">${t.description}</td>
            <td>${getCategoryIcon(t.category)} ${t.category}</td>
            <td style="text-transform: capitalize;">${t.type}</td>
            <td>
                <span class="badge" style="background: ${t.status === 'active' ? 'var(--success)' : 'var(--danger)'}; color: white; font-size: 10px; padding: 2px 6px;">
                    ${t.status.toUpperCase()}
                </span>
            </td>
            <td class="text-right ${t.type}" style="font-weight: 600;">
                ${t.type === 'income' ? '+' : '-'} ₹${Math.round(Math.abs(t.amount)).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
            </td>
        </tr>
    `).join('');
}

function downloadCSV(data: any[]) {
    if (data.length === 0) {
        showStatusNotification("No data to export");
        return;
    }

    const headers = ["Date", "Description", "Category", "Type", "Status", "Amount"];
    
    // Function to escape CSV fields
    const escape = (val) => {
        const str = String(val === undefined || val === null ? "" : val);
        return `"${str.replace(/"/g, '""')}"`;
    };

    const csvContent = [
        headers.join(","),
        ...data.map(t => [
            escape(t.date),
            escape(t.description),
            escape(t.category),
            escape(t.type),
            escape(t.status || 'active'),
            escape(t.amount)
        ].join(","))
    ].join("\n");

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);

    link.setAttribute("href", url);
    link.setAttribute("download", `spendwise_report_${new Date().toISOString().split('T')[0]}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// 🔔 TOAST SYSTEM - Alias for showStatusNotification success
function showToast(msg) {
    showStatusNotification(msg, 'success');
}

// 🧼 FORM RESET
function clearForm() {
    (document.getElementById("transactionForm") as HTMLFormElement)?.reset();
    
    const formTitle = document.getElementById("formTitle");
    const submitBtn = document.getElementById("submitBtn");
    const cancelEditBtn = document.getElementById("cancelEditBtn");

    if (formTitle) formTitle.textContent = "Add New Transaction";
    if (submitBtn) submitBtn.textContent = "Add Transaction";
    if (cancelEditBtn) cancelEditBtn.style.display = "none";
    
    // Set default date to today
    const dateInput = document.getElementById('dateInput') as HTMLInputElement;
    if (dateInput) {
        dateInput.value = new Date().toISOString().split('T')[0];
    }
}

// 💾 ADD / UPDATE LOGIC
function showStatusNotification(msg, type = 'error') {
    const toast = document.getElementById('toast');
    if (!toast) {
        // Only alert if it's a critical error, skip for generic info to avoid "work delay"
        if (type === 'error') console.error(msg);
        return;
    }
    toast.textContent = msg;
    
    // Choose color based on type
    if (type === 'success') {
        toast.style.background = 'var(--success)';
        toast.style.color = 'white';
        toast.style.boxShadow = '0 10px 40px rgba(16, 185, 129, 0.4)';
    } else if (type === 'warning') {
        toast.style.background = '#f59e0b';
        toast.style.color = '#000';
        toast.style.boxShadow = '0 10px 40px rgba(245, 158, 11, 0.5)';
    } else {
        toast.style.background = 'var(--danger)';
        toast.style.color = 'white';
        toast.style.boxShadow = '0 10px 40px rgba(239, 68, 68, 0.4)';
    }

    toast.style.display = 'block';
    setTimeout(() => {
        toast.style.display = 'none';
        // Reset to default toast style if needed
        toast.style.background = 'var(--primary)';
        toast.style.color = '#000';
        toast.style.boxShadow = '0 10px 40px rgba(212, 175, 55, 0.4)';
    }, type === 'warning' ? 4000 : 2500);
}

async function addOrUpdateTransaction() {
    const user = auth.currentUser;
    if (!user) {
        if (isAuthInitialized) {
            showStatusNotification("You must be logged in to save transactions");
        }
        return;
    }

    const desc = (document.getElementById("desc") as HTMLInputElement)?.value.trim() || '';
    const amountInput = (document.getElementById("amount") as HTMLInputElement)?.value || '';
    const amount = parseFloat(amountInput);
    const type = (document.getElementById("type") as HTMLSelectElement)?.value || '';
    const category = (document.getElementById("category") as HTMLSelectElement)?.value || '';
    const dateInput = (document.getElementById("dateInput") as HTMLInputElement)?.value || '';

    if (!desc) {
        showStatusNotification("Description required");
        return;
    }

    if (isNaN(amount) || amount <= 0) {
        showStatusNotification("Amount must be > 0");
        return;
    }

    // Check balance for expenses — warn but still allow the transaction
    let overBudget = false;
    if (type === 'expense') {
        const income = transactions
            .filter(t => t.type === 'income' && t.status === 'active' && t.id !== editId)
            .reduce((sum, t) => sum + parseFloat(t.amount), 0);
        const expense = transactions
            .filter(t => t.type === 'expense' && t.status === 'active' && t.id !== editId)
            .reduce((sum, t) => sum + parseFloat(t.amount), 0);
        const currentBalance = income - expense;

        if (amount > currentBalance) {
            overBudget = true;
        }
    }

    const date = dateInput || new Date().toISOString().split('T')[0];

    const data = { 
        description: desc, 
        amount, 
        type, 
        category, 
        date,
        status: 'active',
        updatedAt: serverTimestamp()
    };

    try {
        // Optimistically clear form and reset edit state for speed
        const currentEditId = editId;
        const currentData = { ...data };
        
        editId = null;
        clearForm();
        
        if (currentEditId) {
            const path = `users/${user.uid}/transactions/${currentEditId}`;
            await updateDoc(doc(db, path), { ...currentData, updatedAt: serverTimestamp() });
            if (overBudget) {
                showStatusNotification("⚠️ Warning: You have spent more than your income!", 'warning');
            } else {
                showStatusNotification("Transaction updated", "success");
            }
        } else {
            const path = `users/${user.uid}/transactions`;
            const newDocRef = doc(collection(db, path));
            await setDoc(newDocRef, { ...currentData, createdAt: serverTimestamp() });
            if (overBudget) {
                showStatusNotification("⚠️ Warning: You have spent more than your income!", 'warning');
            }
        }
    } catch (error) {
        handleFirestoreError(error, editId ? OperationType.UPDATE : OperationType.CREATE, `users/${user.uid}/transactions`);
    }
}

// --- Auth & Init ---
const performDelete = async () => {
    if (transactionToDeleteId === null || !auth.currentUser) return;

    const currentId = transactionToDeleteId;
    const path = `users/${auth.currentUser.uid}/transactions/${currentId}`;
    
    // Immediate UI feedback
    transactionToDeleteId = null;
    const dModal = document.getElementById('deleteModal');
    if (dModal) {
        dModal.style.display = 'none';
        document.body.style.overflow = 'auto';
    }

    try {
        await updateDoc(doc(db, path), {
            status: 'deleted',
            updatedAt: serverTimestamp()
        });
        
        if (editId === currentId) {
            editId = null;
            clearForm();
        }
    } catch (error) {
        handleFirestoreError(error, OperationType.UPDATE, path);
    }
};

const handleLogout = async () => {
    try {
        stopRealtimeListeners();
        await signOut(auth);
        window.location.href = 'index.html';
    } catch (error) {
        console.error("Logout error", error);
    }
};

// Unified Initialization (Ensures data persistence on refresh)
window.onload = () => {
    testFirestoreConnection();
    onAuthStateChanged(auth, async (user) => {
        isAuthInitialized = true;
        const path = window.location.pathname.toLowerCase();
        const isAuthPage = path.includes('index.html') || path.includes('signup.html') || path.includes('forgot-password.html') || path.endsWith('/') || path === '';

        if (user) {
            setupRealtimeListeners(user);
            
            // Fetch User Profile
            try {
                const userDoc = await getDoc(doc(db, 'users', user.uid));
                if (userDoc.exists()) {
                    currentUserProfile = userDoc.data();
                    const welcomeEl = document.getElementById('userNameWelcome');
                    if (welcomeEl) welcomeEl.textContent = `Hi, ${currentUserProfile.name.split(' ')[0]}!`;
                }
            } catch (error) {
                console.error("Error fetching profile", error);
            }

            if (isAuthPage) {
                window.location.href = 'dashboard.html';
            }
        } else {
            stopRealtimeListeners();
            if (!isAuthPage) {
                window.location.href = 'index.html';
            }
        }
        refreshUI();
    });
};

document.addEventListener('DOMContentLoaded', () => {
    const path = window.location.pathname.toLowerCase();

    if (path.includes('dashboard') || path.includes('overview') || path.includes('history')) {
        document.getElementById('logoutBtn')?.addEventListener('click', handleLogout);
        
        document.getElementById('transactionForm')?.addEventListener('submit', (e) => {
            e.preventDefault();
            addOrUpdateTransaction();
        });

        // Initialize date input
        const dateInput = document.getElementById('dateInput') as HTMLInputElement;
        if (dateInput) {
            dateInput.value = new Date().toISOString().split('T')[0];
        }

        document.getElementById('search')?.addEventListener('input', refreshUI);
        document.getElementById('filter')?.addEventListener('change', refreshUI);
        
        document.getElementById('searchHistory')?.addEventListener('input', refreshUI);
        document.getElementById('filterHistory')?.addEventListener('change', refreshUI);

        document.getElementById('viewToggleBtnHistory')?.addEventListener('click', (e) => {
            const fb = document.getElementById('filterBarHistory');
            if (fb) {
                const target = e.target as HTMLElement;
                if (fb.style.display === 'none') {
                    fb.style.display = 'flex';
                    if (target) target.textContent = '← Close Filters';
                } else {
                    fb.style.display = 'none';
                    if (target) target.textContent = 'Filters →';
                }
            }
        });

        document.getElementById('openHistoryModalFull')?.addEventListener('click', () => {
            const hModal = document.getElementById('historyModal');
            if (hModal) {
                hModal.style.display = 'flex';
                document.body.style.overflow = 'hidden'; 
                refreshUI();
            }
        });

        document.getElementById('cancelEditBtn')?.addEventListener('click', (window as any).cancelEdit);

        document.getElementById('viewToggleBtn')?.addEventListener('click', (e) => {
            const fb = document.getElementById('filterBar');
            if (fb) {
                const target = e.target as HTMLElement;
                if (fb.style.display === 'none') {
                    fb.style.display = 'flex';
                    if (target) target.textContent = '← Close Filters';
                } else {
                    fb.style.display = 'none';
                    if (target) target.textContent = 'Filters →';
                }
            }
        });

        // History Modal Handlers
        const hModal = document.getElementById('historyModal');
        document.getElementById('openHistoryModal')?.addEventListener('click', () => {
            if (hModal) {
                hModal.style.display = 'flex';
                document.body.style.overflow = 'hidden'; 
                refreshUI();
            }
        });

        document.getElementById('closeHistoryModal')?.addEventListener('click', () => {
            if (hModal) {
                hModal.style.display = 'none';
                document.body.style.overflow = 'auto';
            }
        });

        window.addEventListener('click', (e) => {
            if (e.target === hModal) {
                hModal.style.display = 'none';
                document.body.style.overflow = 'auto';
            }
        });

        document.getElementById('downloadCsv')?.addEventListener('click', () => {
            const filteredHistory = getFilteredHistory();
            downloadCSV(filteredHistory);
        });

        document.getElementById('historySearch')?.addEventListener('input', refreshUI);
        document.getElementById('historyFilter')?.addEventListener('change', refreshUI);

        // Delete Modal Handlers
        document.getElementById('cancelDeleteBtn')?.addEventListener('click', () => {
            const dModal = document.getElementById('deleteModal');
            if (dModal) {
                dModal.style.display = 'none';
                document.body.style.overflow = 'auto';
            }
            transactionToDeleteId = null;
        });

        document.getElementById('confirmDeleteBtn')?.addEventListener('click', performDelete);

        // Trash Modal Handlers
        const tModal = document.getElementById('trashModal');
        document.getElementById('openTrashModal')?.addEventListener('click', () => {
            if (tModal) {
                tModal.style.display = 'flex';
                document.body.style.overflow = 'hidden';
                refreshUI();
            }
        });

        document.getElementById('closeTrashModal')?.addEventListener('click', () => {
            if (tModal) {
                tModal.style.display = 'none';
                document.body.style.overflow = 'auto';
            }
        });

        window.addEventListener('click', (e) => {
            if (e.target === tModal) {
                tModal.style.display = 'none';
                document.body.style.overflow = 'auto';
            }
        });

        // Change Password Modal Handlers
        const cpModal = document.getElementById('changePasswordModal');
        const cpForm = document.getElementById('changePasswordForm') as HTMLFormElement;
        const cpError = document.getElementById('changePasswordError');
        const confirmBtn = document.getElementById('confirmChangePasswordBtn') as HTMLButtonElement;

        document.getElementById('openChangePasswordModal')?.addEventListener('click', () => {
            if (cpModal) {
                cpModal.style.display = 'flex';
                document.body.style.overflow = 'hidden';
                if (cpError) cpError.textContent = '';
                if (cpForm) cpForm.reset();
            }
        });

        const closeCpModal = () => {
            if (cpModal) {
                cpModal.style.display = 'none';
                document.body.style.overflow = 'auto';
                if (cpForm) cpForm.reset();
                if (cpError) cpError.textContent = '';
            }
        };

        document.getElementById('closeChangePasswordModal')?.addEventListener('click', closeCpModal);
        document.getElementById('cancelChangePasswordBtn')?.addEventListener('click', closeCpModal);
        window.addEventListener('click', (e) => {
            if (e.target === cpModal) {
                closeCpModal();
            }
        });

        cpForm?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const user = auth.currentUser;
            if (!user) {
                if (cpError) {
                    cpError.style.color = 'var(--danger)';
                    cpError.textContent = "You must be signed in to change your password.";
                }
                return;
            }

            const currentPassInput = document.getElementById('currentDashPassword') as HTMLInputElement;
            const newPassInput = document.getElementById('newDashPassword') as HTMLInputElement;
            const confirmPassInput = document.getElementById('confirmDashPassword') as HTMLInputElement;
            const currentPass = currentPassInput?.value;
            const newPass = newPassInput?.value;
            const confirmPass = confirmPassInput?.value;

            if (!currentPass || !newPass || !confirmPass) {
                if (cpError) {
                    cpError.style.color = 'var(--danger)';
                    cpError.textContent = "Please fill in all fields.";
                }
                return;
            }

            if (newPass.length < 6) {
                if (cpError) {
                    cpError.style.color = 'var(--danger)';
                    cpError.textContent = "Password must be at least 6 characters.";
                }
                return;
            }

            if (newPass !== confirmPass) {
                if (cpError) {
                    cpError.style.color = 'var(--danger)';
                    cpError.textContent = "Passwords do not match.";
                }
                return;
            }

            if (confirmBtn) {
                confirmBtn.disabled = true;
                confirmBtn.textContent = 'Updating...';
            }
            if (cpError) {
                cpError.style.color = 'var(--primary)';
                cpError.textContent = 'Verifying credentials...';
            }

            try {
                // Re-authenticate user with their current password first
                const credential = EmailAuthProvider.credential(user.email!, currentPass);
                await reauthenticateWithCredential(user, credential);

                // Now safe to update password
                if (cpError) cpError.textContent = 'Updating your password...';
                await updatePassword(user, newPass);

                if (cpError) {
                    cpError.style.color = 'var(--success)';
                    cpError.textContent = "Success! Password updated successfully.";
                }
                setTimeout(() => {
                    closeCpModal();
                }, 1500);
            } catch (error: any) {
                console.error("Password update failed:", error);
                if (cpError) {
                    cpError.style.color = 'var(--danger)';
                    if (error.code === 'auth/wrong-password' || error.code === 'auth/invalid-credential') {
                        cpError.textContent = "Current password is incorrect. Please try again.";
                    } else if (error.code === 'auth/too-many-requests') {
                        cpError.textContent = "Too many attempts. Please wait a moment and try again.";
                    } else {
                        cpError.textContent = error.message || "Failed to update password.";
                    }
                }
            } finally {
                if (confirmBtn) {
                    confirmBtn.disabled = false;
                    confirmBtn.textContent = 'Save Password';
                }
            }
        });

        // Budget Modal Handlers
        const bModal = document.getElementById('budgetModal');
        document.getElementById('openBudgetModal')?.addEventListener('click', () => {
            if (bModal) {
                populateBudgetFields();
                bModal.style.display = 'flex';
                document.body.style.overflow = 'hidden';
            }
        });

        document.getElementById('closeBudgetModal')?.addEventListener('click', () => {
            if (bModal) {
                bModal.style.display = 'none';
                document.body.style.overflow = 'auto';
            }
        });

        window.addEventListener('click', (e) => {
            if (e.target === bModal) {
                bModal.style.display = 'none';
                document.body.style.overflow = 'auto';
            }
        });

        document.getElementById('cancelBudgetBtn')?.addEventListener('click', () => {
            if (bModal) {
                bModal.style.display = 'none';
                document.body.style.overflow = 'auto';
            }
        });

        document.getElementById('budgetForm')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const user = auth.currentUser;
            if (!user) return;

            const inputs = document.querySelectorAll('.budget-input');
            const promises = [];

            inputs.forEach(input => {
                const el = input as HTMLInputElement;
                const cat = el.dataset.category;
                if (!cat) return;

                const val = parseFloat(el.value) || 0;
                const path = `users/${user.uid}/budgets/${cat}`;
                promises.push(setDoc(doc(db, path), {
                    category: cat,
                    amount: val,
                    updatedAt: serverTimestamp()
                }));
            });

            try {
                await Promise.all(promises);
                showStatusNotification("Budgets updated successfully", "success");
                if (bModal) {
                    bModal.style.display = 'none';
                    document.body.style.overflow = 'auto';
                }
                
                // Explicitly go to dashboard page as requested
                window.location.href = 'dashboard.html';
            } catch (error) {
                handleFirestoreError(error, OperationType.WRITE, `users/${user.uid}/budgets`);
            }
        });

        // Reset Filter Button
        const resetAction = () => {
            console.log("Resetting all filters...");
            // Dashboard IDs
            const searchEl = document.getElementById('search') as HTMLInputElement;
            const filterEl = document.getElementById('filter') as HTMLSelectElement;
            
            // History IDs
            const hSearchEl = document.getElementById('searchHistory') as HTMLInputElement;
            const hFilterEl = document.getElementById('filterHistory') as HTMLSelectElement;
            
            // Modal History IDs
            const mSearchEl = document.getElementById('historySearch') as HTMLInputElement;
            const mFilterEl = document.getElementById('historyFilter') as HTMLSelectElement;

            if (searchEl) searchEl.value = "";
            if (filterEl) filterEl.value = "all";
            
            if (hSearchEl) hSearchEl.value = "";
            if (hFilterEl) hFilterEl.value = "all";
            
            if (mSearchEl) mSearchEl.value = "";
            if (mFilterEl) mFilterEl.value = "all";

            refreshUI();
            
            // Scroll to top for visibility if on dashboard, or to top of history section
            if (path.includes('history.html')) {
                window.scrollTo({ top: 0, behavior: 'smooth' });
            } else {
                const dashboardTop = document.querySelector('.stats-grid');
                if (dashboardTop) dashboardTop.scrollIntoView({ behavior: 'smooth' });
                else window.scrollTo({ top: 0, behavior: 'smooth' });
            }
            
            showStatusNotification("All filters cleared", "success");
        };

        document.getElementById('resetFilterBtn')?.addEventListener('click', resetAction);
        document.getElementById('floatingResetBtn')?.addEventListener('click', resetAction);
        document.getElementById('resetFilterBtnHistory')?.addEventListener('click', resetAction);
    } else if (path.includes('signup')) {
        document.getElementById('signupForm')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const email = (document.getElementById('email') as HTMLInputElement)?.value.trim() || '';
            const pass = (document.getElementById('password') as HTMLInputElement)?.value || '';
            const conf = (document.getElementById('confirmPassword') as HTMLInputElement)?.value || '';
            const name = (document.getElementById('fullName') as HTMLInputElement)?.value || '';

            const err = document.getElementById('signupError');
            if (pass !== conf) { err.textContent = "Passwords do not match"; return; }
            if (pass.length < 6) { err.textContent = "Min 6 characters required"; return; }

            try {
                const userCredential = await createUserWithEmailAndPassword(auth, email, pass);
                const user = userCredential.user;
                
                // Create user profile in Firestore
                const userPath = `users/${user.uid}`;
                try {
                    await setDoc(doc(db, userPath), {
                        name,
                        email,
                        createdAt: serverTimestamp()
                    });
                } catch (fsError) {
                    // If Firestore fails, we still have the auth account, but profile missing
                    console.error("Profile creation failed", fsError);
                    handleFirestoreError(fsError, OperationType.CREATE, userPath);
                }
                
                window.location.href = 'dashboard.html';
            } catch (error: any) {
                console.error("Signup error:", error);
                if (error.code === 'auth/operation-not-allowed') {
                    err.innerHTML = "<b>Action Required:</b><br>Enable <b>Email/Password</b> provider in the Firebase Console (Authentication > Sign-in method).";
                } else if (error.code === 'auth/unauthorized-domain' || error.code === 'auth/network-request-failed') {
                    err.innerHTML = "<b>Action Required:</b><br>Network Error or Unauthorized Domain.<br><br>1. In <a href='https://console.firebase.google.com/project/" + auth.app.options.projectId + "/authentication/settings' target='_blank' style='color:#3b82f6;text-decoration:underline;'>Firebase Console</a>, add <code>" + window.location.hostname + "</code> to <b>Authorized Domains</b>.<br>2. Check for <b>Ad-blockers</b> or use Incognito mode.<br>3. Ensure <b>Identity Toolkit API</b> is allowed for your API Key in <a href='https://console.cloud.google.com/apis/credentials' target='_blank' style='color:#3b82f6;text-decoration:underline;'>Google Cloud</a>.";
                } else if (error.code === 'auth/email-already-in-use') {
                    err.textContent = "This email is already registered. Please sign in.";
                } else if (error.code === 'auth/weak-password') {
                    err.textContent = "Password is too weak. Use at least 6 characters.";
                } else {
                    err.textContent = error.message || "Signup failed. Check console for details.";
                }
            }
        });
    } else if (path.includes('forgot-password')) {
        const urlParams = new URLSearchParams(window.location.search);
        const oobCode = urlParams.get('oobCode');
        const mode = urlParams.get('mode');

        const emailGroup = document.getElementById('emailGroup');
        const resetBtn = document.getElementById('resetBtn') as HTMLButtonElement;
        const errorEl = document.getElementById('resetError');

        if (oobCode && mode === 'resetPassword') {
            // mode for final reset
            if (emailGroup) emailGroup.style.display = 'none';
            const passwordFields = document.getElementById('passwordFields');
            if (passwordFields) passwordFields.style.display = 'none';
            
            if (resetBtn) {
                resetBtn.disabled = true;
                resetBtn.textContent = 'End';
            }

            // Automatic confirmation if password is in localStorage
            const savedPassword = localStorage.getItem('temp_new_password');
            if (savedPassword) {
                confirmPasswordReset(auth, oobCode, savedPassword)
                    .then(() => {
                        localStorage.removeItem('temp_new_password');
                        if (errorEl) {
                            errorEl.style.color = 'var(--success)';
                            errorEl.textContent = "Success! Your password is updated. You can now use the 'End' button to return.";
                        }
                        if (resetBtn) {
                            resetBtn.disabled = false;
                            resetBtn.textContent = 'End';
                            // Redirect on "End"
                            resetBtn.onclick = () => window.location.href = 'index.html';
                        }
                    })
                    .catch((error) => {
                        console.error(error);
                        if (errorEl) {
                            errorEl.style.color = 'var(--danger)';
                            if (error.code === 'auth/network-request-failed' || error.code === 'auth/operation-not-allowed') {
                                errorEl.innerHTML = "<b>Configuration Needed!</b><br>1. In Firebase Console, enable <b>Email/Password</b> provider.<br>2. Ensure this domain is in 'Authorized Domains'.";
                            } else {
                                errorEl.textContent = "Error: " + (error instanceof Error ? error.message : "Reset failed");
                            }
                        }
                        if (resetBtn) {
                            resetBtn.disabled = false;
                            resetBtn.textContent = 'Try Again';
                        }
                        if (passwordFields) passwordFields.style.display = 'block';
                    });
            } else {
                if (passwordFields) passwordFields.style.display = 'block';
                if (resetBtn) {
                    resetBtn.disabled = false;
                    resetBtn.textContent = 'End';
                    resetBtn.onclick = () => window.location.href = 'index.html';
                }
            }
        } else {
            // Initial view
            if (resetBtn) resetBtn.textContent = 'Confirm password';
        }

        document.getElementById('forgotForm')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const newPassInput = document.getElementById('newPassword') as HTMLInputElement;
            const confPassInput = document.getElementById('confirmNewPassword') as HTMLInputElement;
            const newPass = newPassInput?.value;
            const confPass = confPassInput?.value;

            if (oobCode && mode === 'resetPassword') {
                if (!newPass || !confPass) {
                    if (errorEl) {
                        errorEl.style.color = 'var(--danger)';
                        errorEl.textContent = "Please fill in all fields line by line";
                    }
                    return;
                }

                if (newPass !== confPass) {
                    if (errorEl) {
                        errorEl.style.color = 'var(--danger)';
                        errorEl.textContent = "Passwords do not match";
                    }
                    return;
                }
                if (newPass.length < 6) {
                    if (errorEl) {
                        errorEl.style.color = 'var(--danger)';
                        errorEl.textContent = "Password must be at least 6 characters";
                    }
                    return;
                }

                if (resetBtn) {
                    resetBtn.disabled = true;
                    resetBtn.textContent = "Processing...";
                }

                try {
                    await confirmPasswordReset(auth, oobCode, newPass);
                    if (errorEl) {
                        errorEl.style.color = 'var(--success)';
                        errorEl.textContent = "Success! Your password is updated. Redirecting...";
                    }
                    setTimeout(() => {
                        window.location.href = 'index.html';
                    }, 2000);
                } catch (error) {
                    if (resetBtn) {
                        resetBtn.disabled = false;
                        resetBtn.textContent = "End";
                    }
                    if (errorEl) {
                        errorEl.style.color = 'var(--danger)';
                        errorEl.textContent = error instanceof Error ? error.message : "Reset failed";
                    }
                }
            } else {
                const emailInput = document.getElementById('forgotEmail') as HTMLInputElement;
                const email = emailInput ? emailInput.value.trim() : '';

                if (!email || !newPass || !confPass) {
                    if (errorEl) {
                        errorEl.style.color = 'var(--danger)';
                        errorEl.textContent = "Please fill in all fields line by line";
                    }
                    return;
                }

                if (newPass !== confPass) {
                    if (errorEl) {
                        errorEl.style.color = 'var(--danger)';
                        errorEl.textContent = "Passwords do not match";
                    }
                    return;
                }
                
                if (resetBtn) {
                    resetBtn.disabled = true;
                    resetBtn.textContent = "Processing...";
                }

                try {
                    // Save the intended password to localStorage
                    localStorage.setItem('temp_new_password', newPass);

                    await sendPasswordResetEmail(auth, email);
                    if (errorEl) {
                        errorEl.style.color = 'var(--success)';
                        errorEl.innerHTML = "<b>Confirmation mail sent!</b><br>Please click the link in your email to confirm the change.<br><br>⚠️ <b>Note:</b> If you don't receive it within a few minutes, check your <b>Spam / junk / Promotions</b> folder, as Firebase auth emails are often delivered there by default.";
                    }
                    if (resetBtn) {
                        resetBtn.disabled = true;
                        resetBtn.textContent = "Mail Sent";
                    }
                } catch (error: any) {
                    if (resetBtn) {
                        resetBtn.disabled = false;
                        resetBtn.textContent = "Confirm password";
                    }
                    if (errorEl) {
                        errorEl.style.color = 'var(--danger)';
                        if (error.code === 'auth/network-request-failed' || error.code === 'auth/operation-not-allowed') {
                            errorEl.innerHTML = "<b>Action Required:</b><br>1. Enable <b>Email/Password</b> in Firebase Console.<br>2. Add this domain to 'Authorized Domains'.";
                        } else {
                            errorEl.textContent = error instanceof Error ? error.message : "Request failed";
                        }
                    }
                }
            }
        });
    } else {
        // Login Page
        document.getElementById('loginForm')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const email = (document.getElementById('loginEmail') as HTMLInputElement)?.value.trim() || '';
            const pass = (document.getElementById('loginPassword') as HTMLInputElement)?.value || '';

            try {
                await signInWithEmailAndPassword(auth, email, pass);
                window.location.href = 'dashboard.html';
            } catch (error: any) {
                console.error("Login error:", error);
                const err = document.getElementById('loginGlobalError');
                if (err) {
                    if (error.code === 'auth/operation-not-allowed') {
                        err.innerHTML = "<b>Action Required:</b><br>Enable <b>Email/Password</b> provider in Firebase Console (Authentication > Sign-in method).";
                    } else if (error.code === 'auth/unauthorized-domain' || error.code === 'auth/network-request-failed') {
                        err.innerHTML = "<b>Action Required:</b><br>Network Error or Unauthorized Domain.<br><br>1. In <a href='https://console.firebase.google.com/project/" + auth.app.options.projectId + "/authentication/settings' target='_blank' style='color:#3b82f6;text-decoration:underline;'>Firebase Console</a>, add <code>" + window.location.hostname + "</code> to <b>Authorized Domains</b>.<br>2. Check for <b>Ad-blockers</b> or use Incognito mode.<br>3. Ensure <b>Identity Toolkit API</b> is allowed for your API Key in <a href='https://console.cloud.google.com/apis/credentials' target='_blank' style='color:#3b82f6;text-decoration:underline;'>Google Cloud</a>.";
                    } else if (error.code === 'auth/user-not-found' || error.code === 'auth/wrong-password' || error.code === 'auth/invalid-credential') {
                        err.textContent = "Invalid email or password. Please try again.";
                    } else {
                        err.textContent = error.message || "Login failed. Check console for details.";
                    }
                }
            }
        });
    }
});

(window as any).togglePassword = (id: string) => {
    const input = document.getElementById(id) as HTMLInputElement;
    if (!input) return;
    const toggle = input.nextElementSibling;
    if (toggle) {
        if (input.type === 'password') {
            input.type = 'text';
            toggle.textContent = '👁️'; 
        } else {
            input.type = 'password';
            toggle.textContent = '👁️‍🗨️';
        }
    }
};

(window as any).editTransaction = (id: string) => {
    const t = transactions.find(t => t.id === id);
    if (!t) return;

    const descEl = document.getElementById("desc") as HTMLInputElement;
    const amountEl = document.getElementById("amount") as HTMLInputElement;
    const typeEl = document.getElementById("type") as HTMLSelectElement;
    const categoryEl = document.getElementById("category") as HTMLSelectElement;

    if (descEl) descEl.value = t.description;
    if (amountEl) amountEl.value = t.amount;
    if (typeEl) typeEl.value = t.type;
    if (categoryEl) categoryEl.value = t.category;
    
    const dateInput = document.getElementById("dateInput") as HTMLInputElement;
    if (dateInput && t.date) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(t.date)) {
            dateInput.value = t.date;
        } else {
            try {
                const parsed = new Date(t.date);
                if (!isNaN(parsed.getTime())) {
                    dateInput.value = parsed.toISOString().split('T')[0];
                }
            } catch(e) {
                dateInput.value = new Date().toISOString().split('T')[0];
            }
        }
    }

    editId = id;
    const formTitle = document.getElementById("formTitle");
    const submitBtn = document.getElementById("submitBtn");
    const cancelEditBtn = document.getElementById("cancelEditBtn");

    if (formTitle) formTitle.textContent = "Update Transaction";
    if (submitBtn) submitBtn.textContent = "Update Transaction";
    if (cancelEditBtn) cancelEditBtn.style.display = "block";
    
    document.querySelector('.form-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    refreshUI();
};

(window as any).deleteTransaction = (id: string) => {
    transactionToDeleteId = id;
    const dModal = document.getElementById('deleteModal');
    if (dModal) {
        dModal.style.display = 'flex';
        document.body.style.overflow = 'hidden';
    }
};

(window as any).cancelEdit = () => {
    editId = null;
    clearForm();
    refreshUI();
};
