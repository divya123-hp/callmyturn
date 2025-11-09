const express = require('express');
const path = require('path');
const session = require('express-session');
const http = require('http');
const { Server } = require("socket.io");
const mysql = require('mysql');
const fs = require('fs');
const cron = require('node-cron'); // For scheduled tasks

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = 3000;

// =================================================================
// --- DATABASE CONNECTION ---
// =================================================================
const db = mysql.createPool({
    connectionLimit: 10,
    host: 'localhost',
    user: 'root',
    password: '', // default for XAMPP
    database: 'canteen_db'
});

db.getConnection((err, connection) => {
    if (err) {
        console.error('❌ Error connecting to MySQL:', err);
        return;
    }
    console.log('✅ Connected to MySQL Database');
    connection.release();
});

// =================================================================
// --- DAILY CLEANUP AT 1 AM ---
// =================================================================
cron.schedule('0 1 * * *', () => {
    console.log('🧹 Running daily cleanup at 1 AM...');
    db.query(`DELETE FROM orders WHERE status != 'Completed'`, (err, result) => {
        if (err) console.error(err);
        else console.log(`Deleted ${result.affectedRows} incomplete orders`);
    });
    db.query(`DELETE FROM orders WHERE status = 'Completed' AND created_at < NOW() - INTERVAL 23 HOUR`, (err, result) => {
        if (err) console.error(err);
        else console.log(`Deleted ${result.affectedRows} old completed orders`);
    });
    db.query('ALTER TABLE orders AUTO_INCREMENT = 1', (err, result) => {
        if (err) console.error("Error resetting token counter:", err);
        else console.log('- Token counter has been reset to 1.');
    });
    console.log('✅ Cleanup complete');
}, {
    scheduled: true,
    timezone: "Asia/Kolkata"
});

// =================================================================
// --- APP SETUP ---
// =================================================================
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: 'canteen-app-secret',
    resave: false,
    saveUninitialized: true,
}));

// =================================================================
// --- ROUTES ---
// =================================================================

// Main student login page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'student-login.html'));
});

// Staff login page
app.get('/staff-login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'staff-login.html'));
});

// --- NEW --- Show the registration page
app.get('/register', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

// --- NEW --- Handle the registration form
app.post('/register', (req, res) => {
    const { username, password, role } = req.body;

    // TODO: Add check here to see if user already exists
    
    const newUser = {
        username: username,
        password: password, // You should hash this in a real app!
        role: role
    };

    db.query('INSERT INTO users SET ?', newUser, (err, result) => {
        if (err) {
            console.error("Error registering user:", err);
            // If user already exists, it might throw an error
            return res.redirect('/register?error=1');
        }
        console.log(`New user created: ${username}`);
        // Send them to the main login page after they register
        res.redirect('/'); 
    });
});


// ------------------------- STUDENT LOGIN -------------------------
app.post('/user/login', (req, res) => {
    const { username, password } = req.body;
    db.query('SELECT * FROM users WHERE username = ? AND password = ? AND role = "student"',
        [username, password],
        (err, results) => {
            if (err) throw err;
            if (results.length > 0) {
                const user = results[0];
                req.session.user = { id: user.id, username: user.username, role: user.role };
                res.redirect('/student/dashboard');
            } else {
                res.redirect('/?error=1');
            }
        });
});

// ------------------------- STAFF LOGIN -------------------------
app.post('/canteen/login', (req, res) => {
    const { username, password } = req.body;
    db.query('SELECT * FROM users WHERE username = ? AND password = ? AND role = "staff"',
        [username, password],
        (err, results) => {
            if (err) throw err;
            if (results.length > 0) {
                const user = results[0];
                req.session.user = { id: user.id, username: user.username, role: user.role };
                res.redirect('/staff/dashboard');
            } else {
                res.redirect('/staff-login?error=1');
            }
        });
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/'));
});

// Middleware
const isAuthenticated = (role) => (req, res, next) => {
    if (req.session.user && req.session.user.role === role) return next();
    res.redirect('/');
};

// =================================================================
// --- STUDENT ROUTES ---
// =================================================================
app.get('/student/dashboard', isAuthenticated('student'), (req, res) => {
    db.query('SELECT * FROM menu_items WHERE is_available = TRUE ORDER BY name', (err, menuItems) => {
        if (err) throw err;
        let menuHtml = '<h3>No items available.</h3>';
        if (menuItems.length > 0) {
            menuHtml = '';
            menuItems.forEach(item => {
                menuHtml += `
                    <div class="food-card-grid" data-item-id="${item.id}" data-item-name="${item.name}" data-item-price="${item.price}">
                        <img src="${item.imageUrl}" alt="${item.name}" class="food-card-grid-img">
                        <div class="food-card-grid-body">
                            <h3 class="food-card-grid-title">${item.name}</h3>
                            <p class="food-card-grid-price">₹${item.price}</p>
                            <div class="add-btn-container" data-item-id="${item.id}">
                                <button class="btn-add-to-cart" onclick="changeQuantity(${item.id}, 1)"><i class="fas fa-shopping-cart"></i> ADD</button>
                            </div>
                        </div>
                    </div>
                `;
            });
        }
        const dashboardPath = path.join(__dirname, 'public', 'studentdashboard.html');
        const html = fs.readFileSync(dashboardPath, 'utf8');
        res.send(html.replace('', menuHtml));
    });
});

app.post('/student/place-order', isAuthenticated('student'), (req, res) => {
    const { cartItems } = req.body;
    if (!cartItems) return res.redirect('/student/dashboard?error=empty_cart');

    const itemsFromCart = JSON.parse(cartItems);
    if (itemsFromCart.length === 0) return res.redirect('/student/dashboard?error=empty_cart');

    const newOrder = { 
        items: JSON.stringify(itemsFromCart),
        user_id: req.session.user.id,
        status: 'Placed'
    };

    db.query('INSERT INTO orders SET ?', newOrder, (err, result) => {
        if (err) throw err;
        const tokenNumber = result.insertId; 
        io.emit('new_order', { id: tokenNumber, items: itemsFromCart, student: req.session.user.username });
        req.session.lastOrderToken = tokenNumber;
        res.redirect('/order-success');
    });
});

app.get('/order-success', isAuthenticated('student'), (req, res) => {
    const token = req.session.lastOrderToken;
    if (!token) {
        return res.redirect('/student/dashboard');
    }
    const tokenPagePath = path.join(__dirname, 'public', 'token.html');
    const html = fs.readFileSync(tokenPagePath, 'utf8');
    const finalHtml = html.replace('_TOKEN_ID_', token); 
    req.session.lastOrderToken = null; 
    res.send(finalHtml);
});

app.get('/student/my-orders', isAuthenticated('student'), (req, res) => {
    const studentId = req.session.user.id;
    const query = `
        SELECT * FROM orders 
        WHERE user_id = ? AND status != 'Completed' 
        ORDER BY created_at DESC
    `;
    db.query(query, [studentId], (err, orders) => {
        if (err) throw err;
        let ordersHtml = '<h4>You have no active orders.</h4>';
        if (orders.length > 0) {
            ordersHtml = orders.map(order => {
                const items = JSON.parse(order.items);
                const itemList = items.map(i => `<li>${i.name} (x${i.quantity || 1})</li>`).join('');
                let statusClass = '';
                if (order.status === 'Preparing') statusClass = 'status-preparing';
                if (order.status === 'Ready for Pickup') statusClass = 'status-ready';
                return `
                    <div class="order-card-live" id="order-${order.id}">
                        <div class="order-card-live-header">
                            <h3>Token #${order.id}</h3>
                            <span class="order-status-live ${statusClass}">${order.status}</span>
                        </div>
                        <ul>${itemList}</ul>
                    </div>
                `;
            }).join('');
        }
        const pagePath = path.join(__dirname, 'public', 'my-orders.html');
        const html = fs.readFileSync(pagePath, 'utf8');
        res.send(html.replace('', ordersHtml));
    });
});

// =================================================================
// --- STAFF ROUTES ---
// =================================================================
app.get('/staff/dashboard', isAuthenticated('staff'), (req, res) => {
    db.query(`
        SELECT orders.*, users.username 
        FROM orders 
        LEFT JOIN users ON orders.user_id = users.id 
        WHERE orders.status != 'Completed' 
        ORDER BY orders.created_at DESC`, 
        (err, orders) => {
            if (err) throw err;
            let ordersHtml = '<h4>No live orders.</h4>';
            if (orders.length > 0) {
                ordersHtml = orders.map(order => {
                    const items = JSON.parse(order.items);
                    const itemList = items.map(i => `<li>${i.name} x${i.quantity || 1}</li>`).join('');
                    let actionButton = '';
                    if (order.status === 'Placed') actionButton = `<button type="submit" name="newStatus" value="Preparing" class="btn btn-action btn-prepare">Start Preparing</button>`;
                    else if (order.status === 'Preparing') actionButton = `<button type="submit" name="newStatus" value="Ready for Pickup" class="btn btn-action btn-ready">Ready for Pickup</button>`;
                    else if (order.status === 'Ready for Pickup') actionButton = `<button type="submit" name="newStatus" value="Completed" class="btn btn-action">Complete Order</button>`;
                    return `
                        <div class="order-card-staff">
                            <strong>Token #${order.id}</strong><br>
                            <strong>Student:</strong> ${order.username || 'Guest'}<br>
                            <strong>Status:</strong> ${order.status}<br>
                            <ul>${itemList}</ul>
                            <form method="POST" action="/staff/update-order-status" class="order-actions">
                                <input type="hidden" name="orderId" value="${order.id}">
                                ${actionButton}
                            </form>
                        </div>
                    `;
                }).join('');
            }
            const dashboardPath = path.join(__dirname, 'public', 'staffdashboard.html');
            const html = fs.readFileSync(dashboardPath, 'utf8');
            res.send(html.replace('', ordersHtml));
        });
});

app.post('/staff/update-order-status', isAuthenticated('staff'), (req, res) => {
    const { orderId, newStatus } = req.body;
    db.query('UPDATE orders SET status = ? WHERE id = ?', [newStatus, orderId], (err) => {
        if (err) throw err;
        io.emit('order_status_updated', { orderId: orderId, newStatus });
        res.redirect('/staff/dashboard');
    });
});

app.get('/staff/manage-users', isAuthenticated('staff'), (req, res) => {
    db.query('SELECT id, username, role FROM users WHERE role = "student"', (err, users) => {
        if (err) throw err;
        let userListHtml = '<tr><td colspan="3">No users found.</td></tr>';
        if (users.length > 0) {
            userListHtml = users.map(user => `<tr><td>${user.id}</td><td>${user.username}</td><td>${user.role}</td></tr>`).join('');
        }
        const managePagePath = path.join(__dirname, 'public', 'manage-users.html');
        const html = fs.readFileSync(managePagePath, 'utf8');
        res.send(html.replace('', userListHtml));
    });
});

app.get('/staff/manage-menu', isAuthenticated('staff'), (req, res) => {
    db.query('SELECT * FROM menu_items ORDER BY category, name', (err, items) => {
        if (err) throw err;
        let menuListHtml = '<tr><td colspan="5">No menu items found.</td></tr>';
        if (items.length > 0) {
            menuListHtml = items.map(item => `<tr><td>${item.name}</td><td>₹${item.price}</td><td>${item.category}</td><td><span class="${item.is_available ? 'status-available' : 'status-unavailable'}">${item.is_available ? 'In Stock' : 'Out of Stock'}</span></td><td><form action="/staff/toggle-availability" method="POST"><input type="hidden" name="itemId" value="${item.id}"><button type="submit" class="btn btn-toggle">${item.is_available ? 'Mark Out of Stock' : 'Mark In Stock'}</button></form></td></tr>`).join('');
        }
        const manageMenuPage = fs.readFileSync(path.join(__dirname, 'public', 'manage-menu.html'), 'utf8');
        res.send(manageMenuPage.replace('', menuListHtml));
    });
});

app.post('/staff/add-item', isAuthenticated('staff'), (req, res) => {
    const { name, price, category, imageUrl } = req.body;
    const newItem = { name, price: parseInt(price, 10), category, imageUrl, is_available: true };
    db.query('INSERT INTO menu_items SET ?', newItem, (err, result) => {
        if (err) console.error("Error adding item:", err);
        res.redirect('/staff/manage-menu');
    });
});

app.post('/staff/toggle-availability', isAuthenticated('staff'), (req, res) => {
    const { itemId } = req.body;
    const getStatusQuery = 'SELECT is_available FROM menu_items WHERE id = ?';
    db.query(getStatusQuery, [itemId], (err, results) => {
        if (err || results.length === 0) return res.redirect('/staff/manage-menu');
        const newStatus = !results[0].is_available;
        const updateQuery = 'UPDATE menu_items SET is_available = ? WHERE id = ?';
        db.query(updateQuery, [newStatus, itemId], (err, result) => {
            if (err) throw err;
            res.redirect('/staff/manage-menu');
        });
    });
});

// =================================================================
// --- SOCKET.IO ---
// =================================================================
io.on('connection', (socket) => {
    console.log('🟢 A user connected');
    socket.on('disconnect', () => console.log('🔴 User disconnected'));
});

// =================================================================
// --- SERVER START ---
// =================================================================
server.listen(PORT, () => {
    console.log(`🚀 Server running at: http://localhost:${PORT}`);
});