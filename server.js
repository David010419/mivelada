const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const { Resend } = require('resend'); // Nueva librería
require('dotenv').config();

const app = express();
const resend = new Resend(process.env.RESEND_API_KEY);

// --- CONFIGURACIÓN Y MIDDLEWARES ---
app.use(express.json());
app.use(cors());
app.use(express.static('public'));

// --- MIDDLEWARE DE SEGURIDAD ---
const auth = (req, res, next) => {
    const token = req.header('x-auth-token');
    if (!token) return res.status(401).json({ msg: 'No hay token, permiso denegado' });
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.admin = decoded;
        next();
    } catch (e) {
        res.status(400).json({ msg: 'Token no es válido' });
    }
};

// --- CONEXIÓN A BASE DE DATOS ---
const uri = process.env.MONGO_URI;
mongoose.connect(uri)
  .then(() => console.log('✅ Conectado a MongoDB'))
  .catch(err => console.error('❌ Error MongoDB:', err));

// --- MODELO DE DATOS ---
const Booking = mongoose.model('Booking', new mongoose.Schema({
    nombreCliente: String,
    email: String,
    fecha: String, 
    turno: String,
    total: Number,
    estado: { type: String, default: 'Pendiente' },
    createdAt: { type: Date, default: Date.now }
}));

// --- RUTAS DE AUTENTICACIÓN ---
app.post('/api/auth/login', async (req, res) => {
    const { user, password } = req.body;
    if (user === "admin" && password === "MiVelada003") {
        const token = jwt.sign({ id: 'admin_id' }, process.env.JWT_SECRET, { expiresIn: '2h' });
        return res.json({ token });
    }
    res.status(400).json({ msg: "Credenciales inválidas" });
});

// --- RUTA DE RESERVAS (Ahora con Resend) ---
app.post('/api/reservas', async (req, res) => {
    try {
        const nuevaReserva = new Booking(req.body);
        await nuevaReserva.save();
        res.status(201).json({ mensaje: 'Reserva guardada con éxito' });

        const { nombreCliente, email, fecha, turno, total } = req.body;

        // 1. Enviar Email al Admin
        await resend.emails.send({
            from: 'onboarding@resend.dev', // Resend te permite usar este por defecto
            to: process.env.ADMIN_EMAIL,
            subject: `🔔 Nueva Reserva: ${nombreCliente}`,
            html: `<h2>Nueva solicitud</h2><p>Cliente: ${nombreCliente}</p><p>Fecha: ${fecha}</p><p>Total: ${total}€</p>`
        });

        // 2. Enviar Email al Cliente
        await resend.emails.send({
            from: 'onboarding@resend.dev',
            to: email,
            subject: `Confirmación - Mi Velada`,
            html: `<h2>¡Hola ${nombreCliente}!</h2><p>Recibida solicitud para el ${fecha}.</p>`
        });

        console.log("✅ Correos enviados vía API de Resend");

    } catch (error) {
        console.error("❌ Error en Resend o DB:", error.message);
        if (!res.headersSent) res.status(400).json({ error: 'Error al procesar' });
    }
});

// --- RESTO DE RUTAS ---
app.get('/api/reservas/mapa-disponibilidad', async (req, res) => {
    const reservas = await Booking.find({ estado: { $ne: 'Cancelada' } });
    const mapa = {};
    reservas.forEach(r => {
        if (!mapa[r.fecha]) mapa[r.fecha] = [];
        mapa[r.fecha].push(r.turno);
    });
    res.json(mapa);
});

app.get('/api/admin/informes', auth, async (req, res) => {
    const todas = await Booking.find().sort({ createdAt: -1 });
    res.json(todas);
});

app.patch('/api/reservas/:id', auth, async (req, res) => {
    const reserva = await Booking.findByIdAndUpdate(req.params.id, { estado: req.body.estado }, { new: true });
    res.json(reserva);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Servidor en puerto ${PORT}`));