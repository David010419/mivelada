const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const { Resend } = require('resend');
require('dotenv').config();

const app = express();
const resend = new Resend(process.env.RESEND_API_KEY);

// --- CONFIGURACIÓN Y MIDDLEWARES ---
app.use(express.json());
app.use(cors());
app.use(express.static('public'));

// --- CONEXIÓN A BASE DE DATOS ---
const uri = process.env.MONGO_URI;
mongoose.connect(uri)
  .then(() => console.log('✅ Conectado a MongoDB Atlas'))
  .catch(err => console.error('❌ Error MongoDB:', err));

// --- MODELOS DE DATOS ---

// 1. Modelo de Cupones
const DiscountSchema = new mongoose.Schema({
    codigo: { type: String, unique: true, required: true },
    importe: { type: Number, required: true }, // Cantidad a descontar en €
    activo: { type: Boolean, default: true }
});
const Discount = mongoose.model('Discount', DiscountSchema);

// 2. Modelo de Reservas (Actualizado y Completo)
const BookingSchema = new mongoose.Schema({
    nombre: String,
    apellidos: String,
    telefono: String,
    email: String,
    fechaNacimiento: String,
    fecha: String, 
    turno: { type: String, enum: ['Día', 'Noche', 'Día Completo'] },
    suplementos: [String],
    cupónCodigo: { type: String, default: "" },
    descuentoAplicado: { type: Number, default: 0 },
    total: Number, // Total final tras el descuento
    estado: { type: String, default: 'Pendiente' },
    createdAt: { type: Date, default: Date.now }
});
const Booking = mongoose.model('Booking', BookingSchema);

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

// --- RUTAS PÚBLICAS ---

// 1. Login Administrativo
app.post('/api/auth/login', async (req, res) => {
    const { user, password } = req.body;
    if (user === "admin" && password === "MiVelada003") {
        const token = jwt.sign({ id: 'admin_id' }, process.env.JWT_SECRET, { expiresIn: '2h' });
        return res.json({ token });
    }
    res.status(400).json({ msg: "Credenciales inválidas" });
});

// 2. Mapa de Disponibilidad
app.get('/api/reservas/mapa-disponibilidad', async (req, res) => {
    try {
        // Obtenemos todas las que NO estén canceladas
        const reservas = await Booking.find({ estado: { $ne: 'Cancelada' } });
        const mapa = {};
        reservas.forEach(r => {
            if (!mapa[r.fecha]) mapa[r.fecha] = [];
            mapa[r.fecha].push(r.turno);
        });
        res.json(mapa);
    } catch (error) {
        res.status(500).json({ error: "Error" });
    }
});

// 3. Validar Cupón
app.post('/api/validar-cupon', async (req, res) => {
    try {
        const { codigo } = req.body;
        const cupon = await Discount.findOne({ codigo: codigo.toUpperCase(), activo: true });
        
        if (!cupon) {
            return res.status(404).json({ msg: "Cupón no válido o expirado" });
        }
        res.json({ importe: cupon.importe });
    } catch (error) {
        res.status(500).json({ msg: "Error al validar el cupón" });
    }
});

// 4. Crear Reserva
app.post('/api/reservas', async (req, res) => {
    try {
        const nuevaReserva = new Booking(req.body);
        await nuevaReserva.save();

        // Respuesta rápida al cliente
        res.status(201).json({ mensaje: 'Reserva guardada con éxito' });

        // Datos para los correos
        const { nombre, apellidos, email, fecha, turno, total, cupónCodigo, descuentoAplicado } = req.body;

        // Email al Administrador
        await resend.emails.send({
            from: 'Mi Velada <onboarding@resend.dev>',
            to: process.env.ADMIN_EMAIL,
            subject: `🔔 Nueva Reserva: ${nombre} ${apellidos}`,
            html: `
                <h2 style="color: #c5a059;">Nueva solicitud de reserva</h2>
                <p><strong>Cliente:</strong> ${nombre} ${apellidos}</p>
                <p><strong>Fecha:</strong> ${fecha}</p>
                <p><strong>Turno:</strong> ${turno}</p>
                <p><strong>Total:</strong> ${total}€ ${descuentoAplicado > 0 ? `(Cupón: ${cupónCodigo} -${descuentoAplicado}€)` : ''}</p>
                <hr>
                <p>Gestiona esta reserva en el panel de control.</p>
            `
        });

        // Email de Confirmación al Cliente
        await resend.emails.send({
            from: 'Mi Velada <onboarding@resend.dev>',
            to: email,
            subject: `Confirmación de solicitud - Mi Velada`,
            html: `
                <div style="font-family: sans-serif; border: 1px solid #c5a059; padding: 20px;">
                    <h2 style="color: #c5a059;">¡Hola ${nombre}!</h2>
                    <p>Hemos recibido correctamente tu solicitud para el día <strong>${fecha}</strong>.</p>
                    <p><strong>Turno:</strong> ${turno}</p>
                    <p>Nuestro equipo revisará los detalles y te contactará muy pronto.</p>
                </div>
            `
        });

        console.log(`✅ Reserva de ${nombre} procesada con éxito.`);

    } catch (error) {
        console.error("❌ Error en proceso de reserva:", error.message);
        if (!res.headers_sent) res.status(400).json({ error: 'No se pudo procesar la reserva' });
    }
});

// --- RUTAS PROTEGIDAS (ADMIN) ---

// 1. Obtener todas las reservas con detalles de cupones
app.get('/api/admin/informes', auth, async (req, res) => {
    try {
        const todas = await Booking.find().sort({ createdAt: -1 });
        res.json(todas);
    } catch (error) {
        res.status(500).json({ msg: "Error al obtener informes" });
    }
});

// 2. Actualizar estado de reserva
app.patch('/api/reservas/:id', auth, async (req, res) => {
    try {
        const reserva = await Booking.findByIdAndUpdate(
            req.params.id, 
            { estado: req.body.estado }, 
            { new: true }
        );
        res.json(reserva);
    } catch (error) {
        res.status(400).json({ error: 'No se pudo actualizar' });
    }
});

// 3. RUTA ESPECIAL: Crear un cupón (Usar una vez para pruebas)
// Ejemplo: tudeominio.com/api/crear-cupon-inicial
app.get('/api/crear-cupon-inicial', async (req, res) => {
    try {
        const existe = await Discount.findOne({ codigo: "VELADA10" });
        if (!existe) {
            await Discount.create({ codigo: "VELADA10", importe: 10, activo: true });
            return res.send("✅ Cupón 'VELADA10' de 10€ creado con éxito.");
        }
        res.send("El cupón ya existe.");
    } catch (e) { res.status(500).send(e.message); }
});

// --- INICIO DEL SERVIDOR ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor funcionando en puerto ${PORT}`);
});