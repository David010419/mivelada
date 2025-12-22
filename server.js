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

// Configuración del transportador de Gmail
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// --- RUTAS DE AUTENTICACIÓN ---

app.post('/api/auth/login', async (req, res) => {
    const { user, password } = req.body;
    
    // Si la contraseña es MiVelada003, te dejo pasar sin mirar el hash
    if (user === "admin" && password === "MiVelada003") {
        const token = jwt.sign({ id: 'admin_id' }, process.env.JWT_SECRET, { expiresIn: '2h' });
        console.log("✅ Login exitoso (bypass)");
        return res.json({ token });
    }

    res.status(400).json({ msg: "Credenciales inválidas" });
});
// --- RUTAS PÚBLICAS (Calendario y Reservas) ---

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

// RUTA OPTIMIZADA: Reserva y correos
app.post('/api/reservas', async (req, res) => {
    try {
        // 1. Guardar en Base de Datos primero
        const nuevaReserva = new Booking(req.body);
        await nuevaReserva.save();

        // 2. RESPUESTA INMEDIATA AL CLIENTE
        // Enviamos el OK antes de pelear con Gmail para que la web no se congele
        res.status(201).json({ mensaje: 'Reserva guardada con éxito' });

        // 3. ENVÍO DE EMAILS EN SEGUNDO PLANO (Sin 'await' para la respuesta)
        const { nombreCliente, email, fecha, turno, total } = req.body;

        const mailAdmin = {
            from: process.env.EMAIL_USER,
            to: process.env.ADMIN_EMAIL,
            subject: `🔔 Nueva Reserva: ${nombreCliente}`,
            html: `
                <h2 style="color: #c5a059;">Nueva solicitud de reserva</h2>
                <p><strong>Cliente:</strong> ${nombreCliente}</p>
                <p><strong>Fecha:</strong> ${fecha}</p>
                <p><strong>Turno:</strong> ${turno}</p>
                <p><strong>Total estimado:</strong> ${total}€</p>
                <hr>
                <p>Gestiona esta reserva desde el panel de administración.</p>
            `
        };

        const mailCliente = {
            from: process.env.EMAIL_USER,
            to: email,
            subject: `Confirmación de solicitud - Mi Velada`,
            html: `
                <div style="font-family: sans-serif; border: 1px solid #d4af37; padding: 25px; max-width: 600px;">
                    <h2 style="color: #c5a059;">¡Hola ${nombreCliente}!</h2>
                    <p>Hemos recibido correctamente tu solicitud de reserva para <strong>Mi Velada</strong>.</p>
                    <div style="background: #f9f9f9; padding: 15px; border-radius: 5px;">
                        <p style="margin: 5px 0;"><strong>Fecha:</strong> ${fecha}</p>
                        <p style="margin: 5px 0;"><strong>Turno:</strong> ${turno}</p>
                        <p style="margin: 5px 0;"><strong>Total estimado:</strong> ${total}€</p>
                    </div>
                    <p>Nuestro equipo revisará la disponibilidad y se pondrá en contacto contigo a la mayor brevedad posible para finalizar la reserva.</p>
                    <p>Atentamente,<br><strong>El equipo de Mi Velada</strong></p>
                </div>
            `
        };

        // Ejecutamos los envíos sin bloquear el flujo principal
        transporter.sendMail(mailAdmin).catch(e => console.error("Error enviando email admin:", e));
        transporter.sendMail(mailCliente).catch(e => console.error("Error enviando email cliente:", e));

    } catch (error) {
        console.error("Error en proceso de reserva:", error);
        // Si hay un error al guardar en DB, avisamos si no hemos enviado la respuesta aún
        if (!res.headersSent) {
            res.status(400).json({ error: 'No se pudo procesar la reserva' });
        }
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
        const reservaActualizada = await Booking.findByIdAndUpdate(
            req.params.id, 
            { estado }, 
            { new: true }
        );
        res.json(reservaActualizada);
    } catch (error) {
        res.status(400).json({ error: 'No se pudo actualizar la reserva' });
    }
});

// Cambia el puerto fijo por la variable de entorno de Railway
const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor funcionando en el puerto ${PORT}`);
});