const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const cors = require('cors');
require('dotenv').config();

const app = express();

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
const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/mivelada';
mongoose.connect(uri)
  .then(() => console.log('✅ Conectado a la Base de Datos con éxito'))
  .catch(err => console.error('❌ Error al conectar:', err));

// --- MODELO DE DATOS ---
const BookingSchema = new mongoose.Schema({
    nombreCliente: String,
    email: String,
    fecha: String, 
    turno: { type: String, enum: ['Día', 'Noche', 'Día Completo'] },
    total: Number,
    suplementos: [String],
    estado: { type: String, default: 'Pendiente' },
    createdAt: { type: Date, default: Date.now }
});
const Booking = mongoose.model('Booking', BookingSchema);

// --- CONFIGURACIÓN DE CORREO (Intento con Puerto 587) ---
const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false, // false para puerto 587
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    },
    tls: {
        // Configuraciones para evitar bloqueos en redes de nube
        ciphers: 'SSLv3',
        rejectUnauthorized: false
    },
    connectionTimeout: 20000, // 20 segundos
    greetingTimeout: 20000,
    socketTimeout: 20000
});

// Verificación de conexión de correo al arrancar
transporter.verify((error, success) => {
    if (error) {
        console.error("❌ Gmail sigue bloqueado en puerto 587:", error.message);
    } else {
        console.log("✅ ¡CONECTADO! El servidor de correo está listo (Puerto 587)");
    }
});

// --- RUTAS DE AUTENTICACIÓN ---
app.post('/api/auth/login', async (req, res) => {
    const { user, password } = req.body;
    
    // Login con Bypass para MiVelada003
    if (user === "admin" && password === "MiVelada003") {
        const token = jwt.sign({ id: 'admin_id' }, process.env.JWT_SECRET, { expiresIn: '2h' });
        console.log("✅ Login exitoso (bypass)");
        return res.json({ token });
    }

    res.status(400).json({ msg: "Credenciales inválidas" });
});

// --- RUTAS PÚBLICAS ---
app.get('/api/reservas/mapa-disponibilidad', async (req, res) => {
    try {
        const reservas = await Booking.find({ estado: { $ne: 'Cancelada' } });
        const mapa = {};
        reservas.forEach(r => {
            if (!mapa[r.fecha]) mapa[r.fecha] = [];
            mapa[r.fecha].push(r.turno);
        });
        res.json(mapa);
    } catch (error) {
        res.status(500).json({ error: "Error al obtener disponibilidad" });
    }
});

app.post('/api/reservas', async (req, res) => {
    try {
        const nuevaReserva = new Booking(req.body);
        await nuevaReserva.save();

        res.status(201).json({ mensaje: 'Reserva guardada con éxito' });

        const { nombreCliente, email, fecha, turno, total } = req.body;

        const mailAdmin = {
            from: process.env.EMAIL_USER,
            to: process.env.ADMIN_EMAIL,
            subject: `🔔 Nueva Reserva: ${nombreCliente}`,
            html: `<h2 style="color: #c5a059;">Nueva solicitud</h2>
                   <p><strong>Cliente:</strong> ${nombreCliente}</p>
                   <p><strong>Fecha:</strong> ${fecha}</p>
                   <p><strong>Turno:</strong> ${turno}</p>
                   <p><strong>Total:</strong> ${total}€</p>`
        };

        const mailCliente = {
            from: process.env.EMAIL_USER,
            to: email,
            subject: `Confirmación de solicitud - Mi Velada`,
            html: `<div style="font-family: sans-serif; border: 1px solid #d4af37; padding: 25px;">
                   <h2 style="color: #c5a059;">¡Hola ${nombreCliente}!</h2>
                   <p>Hemos recibido tu solicitud para el día <strong>${fecha}</strong> en el turno de <strong>${turno}</strong>.</p>
                   <p>Nos pondremos en contacto contigo lo antes posible para confirmar los detalles.</p>
                   <p>Atentamente,<br>El equipo de Mi Velada</p></div>`
        };

        // Envíos con logs de éxito/error detallados
        transporter.sendMail(mailAdmin)
            .then(info => console.log("✅ Email Admin enviado correctamente"))
            .catch(e => console.error("❌ Error Email Admin:", e.message));

        transporter.sendMail(mailCliente)
            .then(info => console.log("✅ Email Cliente enviado correctamente"))
            .catch(e => console.error("❌ Error Email Cliente:", e.message));

    } catch (error) {
        console.error("Error en proceso de reserva:", error);
        if (!res.headersSent) res.status(400).json({ error: 'No se pudo procesar la reserva' });
    }
});

// --- RUTAS PROTEGIDAS ---
app.get('/api/admin/informes', auth, async (req, res) => {
    try {
        const todas = await Booking.find().sort({ createdAt: -1 });
        res.json(todas);
    } catch (error) {
        res.status(500).json({ msg: "Error al obtener informes" });
    }
});

app.patch('/api/reservas/:id', auth, async (req, res) => {
    try {
        const { estado } = req.body;
        const reservaActualizada = await Booking.findByIdAndUpdate(req.params.id, { estado }, { new: true });
        res.json(reservaActualizada);
    } catch (error) {
        res.status(400).json({ error: 'No se pudo actualizar la reserva' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor funcionando en el puerto ${PORT}`);
});