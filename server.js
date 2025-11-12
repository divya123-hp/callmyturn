// =================================================================
// --- IMPORTS ---
// =================================================================
const express = require('express');
const { Pool } = require('pg'); // <-- Replaced 'mysql' with 'pg'
const bcrypt = require('bcrypt');
const session = require('express-session');
const path = require('path');
const http = require('http');
const { Server } = require("socket.io");
const fs = require('fs');
const cron = require('node-cron');

// =================================================================
// --- APP & SOCKET.IO SETUP ---
// =================================================================
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

// =================================================================
// --- DATABASE CONNECTION (POSTGRESQL) ---
// =================================================================
// Render provides a DATABASE_URL environment variable
// This connects to your new PostgreSQL database
const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false // Required for Render connections
    }
});

// Test DB connection
db.connect((err, client, release) => {
    if (err) {
        return console.error('Error acquiring client', err.stack);
    }
    console.log('🐘 Successfully connected to PostgreSQL database!');
    client.release();
    // After connecting, run the database setup
    initializeDatabase();
});

// =================================================================
// --- NEW: AUTOMATIC DATABASE TABLE CREATOR ---
// =================================================================
async function initializeDatabase() {
    console.log('🔧 Initializing database...');
    const client = await db.connect();
    try {
        // Create users table
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(50) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                role VARCHAR(20) NOT NULL DEFAULT 'student'
            );
        `);
        console.log('✅ "users" table checked/created.');

        // Create menu_items table
        await client.query(`
            CREATE TABLE IF NOT EXISTS menu_items (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                price INT NOT NULL,
                image_url VARCHAR(255),
                is_available INT DEFAULT 1
            );
        `);
        console.log('✅ "menu_items" table checked/created.');

        // Create orders table
        await client.query(`
            CREATE TABLE IF NOT EXISTS orders (
                id SERIAL PRIMARY KEY,
                user_id INT REFERENCES users(id),
                total_price INT NOT NULL,
                status VARCHAR(50) DEFAULT 'Pending',
                items JSONB,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('✅ "orders" table checked/created.');
        console.log('🎉 Database initialization complete!');
        
    } catch (err) {
        console.error('🔥 Error during database initialization:', err);
    } finally {
        client.release();
    }
}


// =================================================================
// --- APP SETUP (MIDDLEWARE) ---
// =================================================================
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json()); // Added for cart submission
app.use(session({
    secret: process.env.SESSION_SECRET || 'a-fallback-secret-key-just-in-case',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: 'auto' }
}));

// =================================================================
// --- AUTHENTICATION MIDDLEWARE ---
// =================================================================
const isAuthenticated = (req, res, next) => {
    if (!req.session.user) {
        return res.redirect('/student-login.html');
    }
    next();
};

const isStaff = (req, res, next) => {
    if (!req.session.user || req.session.user.role !== 'staff') {
        return res.redirect('/staff-login.html');
    }
    next();
};

// =================================================================
// --- HTML FILE SERVING ---
// =================================================================
const servePage = (filePath) => (req, res) => {
    const fullPath = path.join(__dirname, 'public', filePath);
    fs.readFile(fullPath, 'utf8', (err, html) => {
        if (err) {
            console.error(`Error reading file ${filePath}:`, err);
            return res.status(404).send('Page not found');
        }
        res.send(html);
    });
};

app.get('/', servePage('student-login.html'));
app.get('/student-login', servePage('student-login.html'));
app.get('/staff-login', servePage('staff-login.html'));
app.get('/register', servePage('register.html'));
app.get('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) return res.redirect('/');
        res.clearCookie('connect.sid');
        res.redirect('/student-login');
    });
});

// =================================================================
// --- AUTHENTICATION ROUTES (POSTGRESQL SYNTAX) ---
// =================================================================

// User Registration
app.post('/register', async (req, res) => {
    const { username, password, role = 'student' } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        
        // PostgreSQL uses $1, $2, $3 for placeholders
        const query = 'INSERT INTO users (username, password, role) VALUES ($1, $2, $3) RETURNING id';
        const values = [username, hashedPassword, role];
        
        const result = await db.query(query, values);
        
        req.session.user = { id: result.rows[0].id, username, role };
        
        if (role === 'staff') {
            res.redirect('/staffdashboard');
        } else {
            res.redirect('/studentdashboard');
        }
    } catch (err) {
        console.error('Registration error:', err);
        res.status(500).send('Error registering user. Username may already be taken.');
    }
});

// User Login
app.post('/login', async (req, res) => {
    const { username, password, role } = req.body; // role comes from hidden input
    try {
        const query = 'SELECT * FROM users WHERE username = $1 AND role = $2';
        const result = await db.query(query, [username, role]);
        
        if (result.rows.length === 0) {
            return res.status(400).send('Invalid username or password.');
        }

        const user = result.rows[0];
        const match = await bcrypt.compare(password, user.password);

        if (match) {
            req.session.user = { id: user.id, username: user.username, role: user.role };
            if (user.role === 'staff') {
                res.redirect('/staffdashboard');
            } else {
                res.redirect('/studentdashboard');
            }
        } else {
            res.status(400).send('Invalid username or password.');
        }
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).send('An error occurred during login.');
    }
});

// =================================================================
// --- STUDENT ROUTES (POSTGRESQL SYNTAX) ---
// =================================================================

// Student Dashboard - Load Menu
app.get('/studentdashboard', isAuthenticated, async (req, res) => {
    const fullPath = path.join(__dirname, 'public', 'studentdashboard.html');
    try {
        const menuResult = await db.query('SELECT * FROM menu_items WHERE is_available = 1 ORDER BY id');
        let menuHtml = '';

        if (menuResult.rows.length === 0) {
            menuHtml = '<p>The canteen is currently not serving any items. Please check back later!</p>';
        } else {
            menuResult.rows.forEach(item => {
                menuHtml += `
                    <div class="card food-card-grid" data-item-id="${item.id}" data-item-name="${item.name}" data-item-price="${item.price}">
                        <img src="${item.image_url}" alt="${item.name}">
                        <div class="food-card-title">${item.name}</div>
                        <div class="food-card-price">₹${item.price}</div>
                        <div class="add-btn-container" data-item-id="${item.id}">
                            <button class="btn-add-to-cart" onclick="changeQuantity(${item.id}, 1)">
                                <i class="fas fa-shopping-cart"></i> ADD
                            </button>
                        </div>
                    </div>
                `;
            });
        }
        
        fs.readFile(fullPath, 'utf8', (err, html) => {
            if (err) throw err;
            const finalHtml = html.replace('', menuHtml);
            res.send(finalHtml);
        });

    } catch (err) {
        console.error('Error loading student dashboard:', err);
        res.status(500).send('Error loading page.');
    }
});

// Place Order (Transaction)
app.post('/student/place-order', isAuthenticated, async (req, res) => {
    const { cartItems } = req.body; // This is a JSON string
    const userId = req.session.user.id;
    
    // This is a PostgreSQL Transaction
    const client = await db.connect();
    try {
        const items = JSON.parse(cartItems);
        if (items.length === 0) {
            return res.status(400).send('Cart is empty.');
        }

        let totalPrice = 0;
        items.forEach(item => {
            totalPrice += item.price * item.quantity;
        });
        
        // PostgreSQL uses JSONB for storing JSON
        const itemsJson = JSON.stringify(items); 
        
        await client.query('BEGIN'); // Start transaction
        
        // PostgreSQL's RETURNING id (or in this case, *) gets us the new row
        const query = 'INSERT INTO orders (user_id, total_price, status, items) VALUES ($1, $2, $3, $4) RETURNING *';
        const values = [userId, totalPrice, 'Pending', itemsJson];
        
        const result = await client.query(query, values);
        const newOrder = result.rows[0];
        
        await client.query('COMMIT'); // Commit transaction
        
        // Emit to staff
        io.emit('new_order', newOrder); 
        
        // Redirect to token page
        res.redirect(`/student/token/${newOrder.id}`);

    } catch (err) {
        await client.query('ROLLBACK'); // Rollback on error
        console.error('Error placing order:', err);
        res.status(500).send('Error placing order.');
    } finally {
        client.release(); // Release client back to pool
    }
});

// Get My Orders Page
app.get('/student/my-orders', isAuthenticated, (req, res) => {
    servePage('my-orders.html')(req, res);
});

// Get Token Page
app.get('/student/token/:orderId', isAuthenticated, (req, res) => {
    servePage('token.html')(req, res);
});

// API: Get orders for "My Orders" page (for fetch)
app.get('/api/student/my-orders', isAuthenticated, async (req, res) => {
    try {
        const query = 'SELECT * FROM orders WHERE user_id = $1 AND created_at > NOW() - INTERVAL \'24 hours\' ORDER BY created_at DESC';
        const result = await db.query(query, [req.session.user.id]);
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching student orders:', err);
        res.status(500).json({ error: 'Failed to fetch orders' });
    }
});

// API: Get single order status (for token page)
app.get('/api/student/order-status/:orderId', isAuthenticated, async (req, res) => {
    try {
        const query = 'SELECT id, status, total_price, items FROM orders WHERE id = $1 AND user_id = $2';
        const result = await db.query(query, [req.params.orderId, req.session.user.id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Order not found' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Error fetching order status:', err);
        res.status(500).json({ error: 'Failed to fetch order status' });
    }
});

// =================================================================
// --- STAFF ROUTES (POSTGRESQL SYNTAX) ---
// =================================================================

// Staff Dashboard - Load Orders
app.get('/staffdashboard', isStaff, async (req, res) => {
    const fullPath = path.join(__dirname, 'public', 'staffdashboard.html');
    try {
        // Get all non-completed orders from the last 24 hours
        const query = `
            SELECT o.id, o.status, o.items, o.total_price, u.username 
            FROM orders o
            JOIN users u ON o.user_id = u.id
            WHERE o.status != 'Completed' AND o.created_at > NOW() - INTERVAL '24 hours'
            ORDER BY o.created_at ASC
        `;
        const result = await db.query(query);
        let ordersHtml = '';

        if (result.rows.length === 0) {
            ordersHtml = '<h3>No pending orders.</h3>';
        } else {
            result.rows.forEach(order => {
                ordersHtml += buildOrderCard(order); // We will define this function
            });
        }
        
        fs.readFile(fullPath, 'utf8', (err, html) => {
            if (err) throw err;
            const finalHtml = html.replace('', ordersHtml);
            res.send(finalHtml);
        });

    } catch (err) {
        console.error('Error loading staff dashboard:', err);
        res.status(500).send('Error loading page.');
    }
});

// Helper function to build order card HTML
function buildOrderCard(order) {
    let itemsHtml = '<ul>';
    order.items.forEach(item => {
        itemsHtml += `<li>${item.quantity} x ${item.name}</li>`;
    });
    itemsHtml += '</ul>';

    const isPending = order.status === 'Pending';
    const isPreparing = order.status === 'Preparing';
    const isReady = order.status === 'Ready';

    return `
        <div class="card order-card card-status-${order.status.toLowerCase()}">
            <div class="order-card-header">
                <h4>Token #${order.id}</h4>
                <span>User: ${order.username}</span>
            </div>
            <div class="order-card-body">
                ${itemsHtml}
            </div>
            <div class="order-card-footer">
                <strong>Total: ₹${order.total_price}</strong>
                <div class="order-card-actions">
                    <form action="/staff/update-status" method="POST" style="display: inline;">
                        <input type="hidden" name="orderId" value="${order.id}">
                        <input type="hidden" name="newStatus" value="Preparing">
                        <button type="submit" class="btn btn-status-prep" ${!isPending ? 'disabled' : ''}>
                            <i class="fas fa-hourglass-start"></i> Start Prep
                        </button>
                    </form>
                    <form action="/staff/update-status" method="POST" style="display: inline;">
                        <input type="hidden" name="orderId" value="${order.id}">
                        <input type="hidden" name="newStatus" value="Ready">
                        <button type="submit" class="btn btn-status-ready" ${!isPreparing ? 'disabled' : ''}>
                            <i class="fas fa-bell"></i> Mark Ready
                        </button>
                    </form>
                    <form action="/staff/update-status" method="POST" style="display: inline;">
                        <input type="hidden" name="orderId" value="${order.id}">
                        <input type="hidden" name="newStatus" value="Completed">
                        <button type="submit" class="btn btn-status-done" ${!isReady ? 'disabled' : ''}>
                            <i class="fas fa-check-circle"></i> Mark Completed
                        </button>
                    </form>
                </div>
            </div>
        </div>
    `;
}

// Staff: Update Order Status
app.post('/staff/update-status', isStaff, async (req, res) => {
    const { orderId, newStatus } = req.body;
    try {
        const query = 'UPDATE orders SET status = $1 WHERE id = $2 RETURNING *';
        const result = await db.query(query, [newStatus, orderId]);

        if (result.rows.length > 0) {
            // Emit status update to the specific student's "room"
            const updatedOrder = result.rows[0];
            const studentRoom = `user_${updatedOrder.user_id}`;
            io.to(studentRoom).emit('order_status_update', updatedOrder);
            
            // Also emit to a general 'token' room for the token page
            const tokenRoom = `order_${orderId}`;
            io.to(tokenRoom).emit('order_status_update', updatedOrder);
        }
        res.redirect('/staffdashboard');
    } catch (err) {
        console.error('Error updating status:', err);
        res.status(500).send('Error updating status.');
    }
});


// --- Menu Management Routes ---

app.get('/staff/manage-menu', isStaff, async (req, res) => {
    const fullPath = path.join(__dirname, 'public', 'manage-menu.html');
    try {
        const result = await db.query('SELECT * FROM menu_items ORDER BY id');
        let tableRows = '';
        result.rows.forEach(item => {
            tableRows += `
                <tr>
                    <td>${item.id}</td>
                    <td><img src="${item.image_url}" alt="${item.name}" class="menu-item-thumbnail"></td>
                    <td>${item.name}</td>
                    <td>₹${item.price}</td>
                    <td>${item.is_available == 1 ? 'Yes' : 'No'}</td>
                    <td>
                        <form action="/staff/menu/toggle" method="POST" style="display:inline;">
                            <input type="hidden" name="id" value="${item.id}">
                            <input type="hidden" name="current_status" value="${item.is_available}">
                            <button type="submit" class="btn btn-secondary">
                                ${item.is_available == 1 ? 'Make Unavailable' : 'Make Available'}
                            </button>
                        </form>
                    </td>
                </tr>
            `;
        });
        
        fs.readFile(fullPath, 'utf8', (err, html) => {
            if (err) throw err;
            const finalHtml = html.replace('', tableRows);
            res.send(finalHtml);
        });
    } catch (err) {
        console.error('Error loading menu management:', err);
        res.status(500).send('Error loading page.');
    }
});

app.post('/staff/menu/add', isStaff, async (req, res) => {
    const { name, price, image_url } = req.body;
    try {
        const query = 'INSERT INTO menu_items (name, price, image_url, is_available) VALUES ($1, $2, $3, 1)';
        await db.query(query, [name, price, image_url]);
        res.redirect('/staff/manage-menu');
    } catch (err) {
        console.error('Error adding menu item:', err);
        res.status(500).send('Error adding item.');
    }
});

app.post('/staff/menu/toggle', isStaff, async (req, res) => {
    const { id, current_status } = req.body;
    // New status is the opposite of the current status
    const newStatus = (current_status == 1) ? 0 : 1; 
    try {
        const query = 'UPDATE menu_items SET is_available = $1 WHERE id = $2';
        await db.query(query, [newStatus, id]);
        res.redirect('/staff/manage-menu');
    } catch (err) {
        console.error('Error toggling menu item:', err);
        res.status(500).send('Error toggling item.');
    }
});

// =================================================================
// --- SOCKET.IO LOGIC ---
// =================================================================
io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    // Join a room based on user ID (for "My Orders")
    socket.on('join_user_room', (userId) => {
        socket.join(`user_${userId}`);
        console.log(`User ${socket.id} joined room user_${userId}`);
    });

    // Join a room based on order ID (for "Token Page")
    socket.on('join_token_room', (orderId) => {
        socket.join(`order_${orderId}`);
        console.log(`User ${socket.id} joined room order_${orderId}`);
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
    });
});

// =================================================================
// --- DAILY CLEANUP AT 1 AM (POSTGRESQL SYNTAX) ---
// =================================================================
cron.schedule('0 1 * * *', async () => {
    console.log('🧹 Running daily cleanup at 1 AM...');
    const client = await db.connect();
    try {
        // 1. Deletes old, incomplete orders
        await client.query("DELETE FROM orders WHERE status != 'Completed'");
        
        // 2. Deletes old, completed orders
        await client.query("DELETE FROM orders WHERE status = 'Completed' AND created_at < NOW() - INTERVAL '23 hours'");
        
        // 3. THIS IS THE TOKEN RESET
        // This command resets the 'id' counter (sequence) of the 'orders' table
        // Note: The sequence name 'orders_id_seq' is the default for a SERIAL column.
        await client.query('ALTER SEQUENCE orders_id_seq RESTART WITH 1');
        
        console.log('✅ Cleanup complete. Token counter reset to 1.');
    } catch (err) {
        console.error('Error during daily cleanup:', err);
    } finally {
        client.release();
    }
}, {
    scheduled: true,
    timezone: "Asia/Kolkata"
});

// =================================================================
// --- START SERVER ---
// =================================================================
server.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});