// FirmaYa Worker — Cloudflare Worker
// Endpoints:
//   POST /api/send       → registra doc en KV y envía email al firmante (opcional)
//   POST /api/upload     → sube archivo del doc a KV para que el cliente lo vea
//   GET  /api/file       → sirve el archivo del doc desde KV
//   POST /api/sign       → registra la firma (guarda en KV)
//   GET  /api/check      → consulta si un token fue firmado
//   GET  /api/acms       → obtiene lista de ACMs guardados por agente
//   POST /api/acms       → guarda un ACM en la nube
//   DELETE /api/acms     → elimina un ACM por id
//   GET  /api/borrador   → obtiene el borrador guardado por agente
//   POST /api/borrador   → guarda el borrador del agente
//   DELETE /api/borrador → elimina el borrador del agente
//   GET  /api/registro   → obtiene el registro de ventas del equipo
//   POST /api/registro   → guarda el registro de ventas completo
//   POST /api/otp/send   → genera y envía código OTP por email al firmante
//   POST /api/otp/verify → verifica el código OTP ingresado por el firmante
//   GET  /api/photos     → obtiene selfie + foto DNI guardadas al firmar
//   GET  /api/visitas-tasacion → proxy para leer contador sin CORS
//
// KV Binding requerido: FIRMAYA_KV
// Secret requerido:     RESEND_API_KEY

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PoST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status=200){
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS }
  });
}