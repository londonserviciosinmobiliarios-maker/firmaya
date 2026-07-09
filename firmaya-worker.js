// FirmaYa Worker — Cloudflare Worker
// Endpoints:
//   POST /api/send       → registra doc en KV y envía email al firmante (opcional)
//   POST /api/upload     → sube archivo del doc a KV para que el cliente lo vea
//   GET  /api/file       → sirve el archivo del doc desde KV
//   POST /api/sign       → registra la firma (guarda en KV)
//   GET  /api/list       → lista documentos guardados en KV
//   GET  /api/doc        → obtiene metadata de un documento por token
//   DELETE /api/doc      → elimina metadata, archivo y fotos por token
//   DELETE /api/delete   → alias compatible para eliminar por token
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
//
// KV Binding requerido: FIRMAYA_KV
// Secret requerido:     RESEND_API_KEY

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status=200){
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS }
  });
}

function publicDoc(data){
  if(!data) return null;
  return {
    token: data.token || '',
    docNombre: data.docNombre || data.fileNombre || 'Documento',
    firmante: data.firmante || data.emailFirmante || '—',
    emailFirmante: data.emailFirmante || data.email || '',
    estado: data.estado || 'Pendiente',
    creadoEn: data.creadoEn || null,
    firmadoEn: data.firmadoEn || null,
    fileMime: data.fileMime || '',
    fileNombre: data.fileNombre || '',
    dni: data.dni || '',
    lat: data.lat || '',
    lng: data.lng || '',
    location: data.location || '',
    ip: data.ip || '',
    device: data.device || '',
    otpEmail: data.otpEmail || '',
    selfie: data.selfie || '',
    dniFoto: data.dniFoto || '',
    liveness: data.liveness || '',
    tieneFotos: data.tieneFotos || '',
    tieneFirma: data.tieneFirma || '',
    signPosition: data.signPosition || null
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if(request.method === 'OPTIONS'){
      return new Response(null, { status: 204, headers: CORS });
    }

    // ── GET /api/list ────────────────────────────────────────────────────────
    // Lista documentos reales guardados en KV para el panel admin.
    if(url.pathname === '/api/list' && request.method === 'GET'){
      if(!env.FIRMAYA_KV) return json({ ok: false, docs: [], error: 'KV no configurado' }, 500);
      try{
        const listed = await env.FIRMAYA_KV.list({ prefix: 'doc:', limit: 1000 });
        const docs = [];
        for(const key of listed.keys || []){
          const data = await env.FIRMAYA_KV.get(key.name, 'json');
          const doc = publicDoc(data);
          if(doc && doc.token) docs.push(doc);
        }
        docs.sort((a,b) => new Date(b.creadoEn || b.firmadoEn || 0) - new Date(a.creadoEn || a.firmadoEn || 0));
        return json({ ok: true, docs });
      }catch(e){
        return json({ ok: false, docs: [], error: e.message }, 500);
      }
    }

    // ── GET /api/doc ─────────────────────────────────────────────────────────
    if(url.pathname === '/api/doc' && request.method === 'GET'){
      const token = url.searchParams.get('token');
      if(!token) return json({ ok: false, error: 'Token requerido' }, 400);
      if(!env.FIRMAYA_KV) return json({ ok: false, error: 'KV no configurado' }, 500);
      try{
        const data = await env.FIRMAYA_KV.get('doc:' + token, 'json');
        if(!data) return json({ ok: false, error: 'Documento no encontrado' }, 404);
        return json({ ok: true, doc: publicDoc(data) });
      }catch(e){
        return json({ ok: false, error: e.message }, 500);
      }
    }

    // ── DELETE /api/doc ──────────────────────────────────────────────────────
    if((url.pathname === '/api/doc' || url.pathname === '/api/delete') && request.method === 'DELETE'){
      const token = url.searchParams.get('token');
      if(!token) return json({ ok: false, error: 'Token requerido' }, 400);
      if(!env.FIRMAYA_KV) return json({ ok: false, error: 'KV no configurado' }, 500);
      try{
        await Promise.all([
          env.FIRMAYA_KV.delete('doc:' + token),
          env.FIRMAYA_KV.delete('file:' + token),
          env.FIRMAYA_KV.delete('photos:' + token)
        ]);
        return json({ ok: true });
      }catch(e){
        return json({ ok: false, error: e.message }, 500);
      }
    }

    // ── POST /api/send ────────────────────────────────────────────────────────
    // Registra el documento en KV y OPCIONALMENTE envía email
    if(url.pathname === '/api/send' && request.method === 'POST'){
      try{
        const body = await request.json();
        const { token, docNombre, firmante, emailFirmante, firmarUrl, sendEmail, signPosition } = body;
        if(!token || !firmarUrl || !docNombre || !firmante) return json({ok:false, error:'Faltan datos'}, 400);
        if(sendEmail !== false && !emailFirmante) return json({ok:false, error:'Email del firmante requerido'}, 400);

        // Siempre guardar en KV (funciona para email Y WhatsApp)
        if(env.FIRMAYA_KV){
          const existing = (await env.FIRMAYA_KV.get('doc:' + token, 'json')) || {};
          await env.FIRMAYA_KV.put('doc:' + token, JSON.stringify({
            ...existing,
            token, docNombre, firmante, emailFirmante, firmarUrl,
            signPosition: signPosition || existing.signPosition || null,
            estado: 'Pendiente',
            creadoEn: existing.creadoEn || new Date().toISOString()
          }), { expirationTtl: 60 * 60 * 24 * 90 });
        }

        // Solo enviar email si se pide y hay email
        if(sendEmail !== false){
          if(!env.RESEND_API_KEY) return json({ ok: false, error: 'RESEND_API_KEY no configurado' }, 500);
          const emailResp = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Authorization': 'Bearer ' + env.RESEND_API_KEY,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              from: 'FirmaYa <noreply@londonserviciosinmobiliarios.com.ar>',
              to: [emailFirmante],
              subject: 'Tenés un documento para firmar: ' + docNombre,
              html: `
<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;background:#f5f8fa;padding:32px">
  <div style="background:white;border-radius:16px;padding:32px;box-shadow:0 4px 20px rgba(0,0,0,.08)">
    <div style="text-align:center;margin-bottom:24px">
      <div style="font-family:Georgia,serif;font-size:26px;font-weight:700;color:#0D6278">FirmaYa</div>
      <div style="font-size:11px;letter-spacing:2px;color:#8A9BAB;text-transform:uppercase">Firma Electrónica Digital</div>
    </div>
    <h2 style="font-size:20px;color:#1A2B35;margin-bottom:12px">Hola ${firmante},</h2>
    <p style="color:#4A6070;font-size:15px;line-height:1.6;margin-bottom:20px">
      <strong>London Servicios Inmobiliarios</strong> te envió el documento <strong>"${docNombre}"</strong> para tu firma electrónica.
    </p>
    <div style="text-align:center;margin:28px 0">
      <a href="${firmarUrl}" style="background:#0D6278;color:white;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;display:inline-block">
        ✍️ Firmar documento →
      </a>
    </div>
    <p style="color:#8A9BAB;font-size:12px;text-align:center;margin-top:20px">
      Este link es personal e intransferible. Token: ${token}
    </p>
    <hr style="border:none;border-top:1px solid #D0DDE5;margin:20px 0">
    <p style="color:#8A9BAB;font-size:11px;text-align:center">
      London Servicios Inmobiliarios · Caseros 992 Of. B PB, Córdoba<br>
      Powered by FirmaYa
    </p>
  </div>
</div>`
            })
          });
          let emailData = {};
          try{ emailData = await emailResp.json(); }catch(_){}
          if(!emailResp.ok){
            return json({ ok: false, emailEnviado: false, error: emailData.message || emailData.error || 'Error al enviar email' }, 502);
          }
          return json({ ok: true, emailEnviado: emailResp.ok, emailId: emailData.id });
        }

        return json({ ok: true, emailEnviado: false });

      }catch(e){
        return json({ ok: false, error: e.message }, 500);
      }
    }

    // ── POST /api/upload ─────────────────────────────────────────────────────
    // Sube el archivo del doc a KV para que el cliente pueda verlo
    if(url.pathname === '/api/upload' && request.method === 'POST'){
      try{
        const token  = url.searchParams.get('token');
        const mime   = url.searchParams.get('mime')   || 'application/octet-stream';
        const nombre = url.searchParams.get('nombre') || 'documento';
        if(!token) return json({ok:false, error:'Token requerido'}, 400);

        const buf = await request.arrayBuffer();
        if(!buf || buf.byteLength === 0) return json({ok:false, error:'Archivo vacío'}, 400);

        if(env.FIRMAYA_KV){
          // Guardar bytes del archivo
          await env.FIRMAYA_KV.put('file:' + token, buf, { expirationTtl: 60 * 60 * 24 * 90 });
          // Guardar metadata del archivo en el registro del doc
          const docData = (await env.FIRMAYA_KV.get('doc:' + token, 'json')) || {};
          docData.fileMime   = mime;
          docData.fileNombre = nombre;
          await env.FIRMAYA_KV.put('doc:' + token, JSON.stringify(docData), { expirationTtl: 60 * 60 * 24 * 90 });
        }

        return json({ ok: true, size: buf.byteLength });
      }catch(e){
        return json({ ok: false, error: e.message }, 500);
      }
    }

    // ── GET /api/file ─────────────────────────────────────────────────────────
    // Sirve el archivo del doc para que el cliente lo vea antes de firmar
    if(url.pathname === '/api/file'){
      const token = url.searchParams.get('token');
      if(!token) return json({ ok: false, error: 'Token requerido' }, 400);
      if(!env.FIRMAYA_KV) return json({ ok: false, error: 'KV no configurado' });

      try{
        const [docData, buf] = await Promise.all([
          env.FIRMAYA_KV.get('doc:' + token, 'json'),
          env.FIRMAYA_KV.get('file:' + token, 'arrayBuffer')
        ]);
        if(!buf) return json({ ok: false, error: 'Archivo no encontrado' }, 404);

        const mime   = docData?.fileMime   || 'application/octet-stream';
        const nombre = docData?.fileNombre || 'documento';
        return new Response(buf, {
          status: 200,
          headers: {
            'Content-Type': mime,
            'Content-Disposition': 'inline; filename="' + nombre + '"',
            ...CORS
          }
        });
      }catch(e){
        return json({ ok: false, error: e.message }, 500);
      }
    }

    // ── POST /api/sign ───────────────────────────────────────────────────────
    if(url.pathname === '/api/sign' && request.method === 'POST'){
      try{
        const body = await request.json();
        const { token, firmante, email, dni, docNombre } = body;
        if(!token) return json({ok:false, error:'Token requerido'}, 400);

        const firmadoEn = new Date().toISOString();
        const cf = request.cf || {};
        const lat = body.lat || cf.latitude || '';
        const lng = body.lng || cf.longitude || '';
        const ip = body.ip || request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || '';
        const device = body.device || request.headers.get('User-Agent') || '';
        const location = body.location || [cf.city, cf.region, cf.country].filter(Boolean).join(', ');

        if(env.FIRMAYA_KV){
          const existing = await env.FIRMAYA_KV.get('doc:' + token, 'json');
          const docData = existing || { token, docNombre };
          docData.estado    = 'Firmado';
          docData.firmante  = firmante;
          docData.email     = email;
          docData.dni       = dni;
          docData.firmadoEn = firmadoEn;
          docData.lat       = lat;
          docData.lng       = lng;
          docData.location  = location;
          docData.ip        = ip;
          docData.device    = device;
          // Flags de verificación (sin los datos de foto — esos van en photos:TOKEN)
          docData.otpEmail  = body.otpEmail  || 'no';
          docData.selfie    = body.selfie    || 'no';
          docData.dniFoto   = body.dniFoto   || 'no';
          docData.liveness  = body.liveness  || 'no';
          docData.tieneFotos = (body.selfieImg || body.dniFotoImg) ? 'sí' : 'no';
          docData.tieneFirma = body.firmaImg ? 'sí' : 'no';
          await env.FIRMAYA_KV.put('doc:' + token, JSON.stringify(docData), { expirationTtl: 60 * 60 * 24 * 365 });

          // Guardar fotos en clave separada para no inflar el registro principal
          if(body.selfieImg || body.dniFotoImg || body.firmaImg){
            const photos = {
              selfie:     body.selfieImg  || null,
              dniFoto:    body.dniFotoImg || null,
              firma:      body.firmaImg    || null,
              firmante,
              token,
              guardadoEn: firmadoEn
            };
            await env.FIRMAYA_KV.put('photos:' + token, JSON.stringify(photos), { expirationTtl: 60 * 60 * 24 * 365 });
          }
        }

        // Notificar al equipo London con email mejorado + fotos adjuntas
        if(env.RESEND_API_KEY){
          const docNombreFinal = docNombre || token;
          const fechaLegible   = new Date(firmadoEn).toLocaleString('es-AR');

          // Badges de verificación
          const v = (flag) => flag === 'sí'
            ? '<span style="color:#27AE60;font-weight:700">✅ Sí</span>'
            : '<span style="color:#aaa">—</span>';

          const emailPayload = {
            from: 'FirmaYa <noreply@londonserviciosinmobiliarios.com.ar>',
            to:   ['londonserviciosinmobiliarios@gmail.com'],
            subject: '✅ ' + firmante + ' firmó: ' + docNombreFinal,
            html: `
<div style="font-family:Arial,sans-serif;max-width:580px;margin:0 auto;background:#F5F8FA;padding:28px">
  <div style="background:white;border-radius:16px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.08)">

    <!-- Header -->
    <div style="background:linear-gradient(135deg,#0D6278,#1A7A92);padding:24px 28px;display:flex;align-items:center;justify-content:space-between">
      <div>
        <div style="font-family:Georgia,serif;font-size:20px;font-weight:700;color:white">FirmaYa</div>
        <div style="font-size:10px;color:rgba(255,255,255,.65);letter-spacing:2px;text-transform:uppercase">London Servicios Inmobiliarios</div>
      </div>
      <div style="background:rgba(255,255,255,.15);border-radius:10px;padding:8px 16px;text-align:center">
        <div style="font-size:22px">✅</div>
        <div style="font-size:10px;color:white;font-weight:700;letter-spacing:1px">FIRMADO</div>
      </div>
    </div>

    <div style="padding:28px">

      <!-- Título -->
      <h2 style="font-size:18px;color:#1A2B35;margin:0 0 4px">${firmante} firmó un documento</h2>
      <p style="font-size:13px;color:#8A9BAB;margin:0 0 24px">${fechaLegible}</p>

      <!-- Datos principales -->
      <table style="width:100%;border-collapse:collapse;font-size:13px;border:1px solid #E0E8EC;border-radius:8px;overflow:hidden;margin-bottom:20px">
        <tr><td style="padding:10px 14px;color:#8A9BAB;font-size:11px;text-transform:uppercase;letter-spacing:.5px;width:38%;font-weight:600">Firmante</td><td style="padding:10px 14px;font-weight:700;color:#1A2B35">${firmante}</td></tr>
        <tr style="background:#F5F8FA"><td style="padding:10px 14px;color:#8A9BAB;font-size:11px;text-transform:uppercase;letter-spacing:.5px;font-weight:600">DNI</td><td style="padding:10px 14px;font-weight:700;color:#1A2B35">${dni||'—'}</td></tr>
        <tr><td style="padding:10px 14px;color:#8A9BAB;font-size:11px;text-transform:uppercase;letter-spacing:.5px;font-weight:600">Email</td><td style="padding:10px 14px;font-weight:700;color:#1A2B35">${email}</td></tr>
        <tr style="background:#F5F8FA"><td style="padding:10px 14px;color:#8A9BAB;font-size:11px;text-transform:uppercase;letter-spacing:.5px;font-weight:600">Documento</td><td style="padding:10px 14px;font-weight:700;color:#1A2B35">${docNombreFinal}</td></tr>
        <tr><td style="padding:10px 14px;color:#8A9BAB;font-size:11px;text-transform:uppercase;letter-spacing:.5px;font-weight:600">Fecha y hora</td><td style="padding:10px 14px;font-weight:700;color:#1A2B35">${fechaLegible}</td></tr>
        <tr style="background:#F5F8FA"><td style="padding:10px 14px;color:#8A9BAB;font-size:11px;text-transform:uppercase;letter-spacing:.5px;font-weight:600">Token</td><td style="padding:10px 14px;font-weight:600;color:#1A2B35;font-size:11px;font-family:monospace">${token}</td></tr>
      </table>

      <!-- Verificaciones de identidad -->
      <div style="font-size:11px;font-weight:700;color:#8A9BAB;text-transform:uppercase;letter-spacing:.6px;margin-bottom:10px">🔐 Verificaciones de identidad</div>
      <table style="width:100%;border-collapse:collapse;font-size:13px;border:1px solid #E0E8EC;border-radius:8px;overflow:hidden;margin-bottom:20px">
        <tr><td style="padding:9px 14px;color:#8A9BAB;font-size:11px;text-transform:uppercase;letter-spacing:.5px;font-weight:600;width:55%">Código OTP por email</td><td style="padding:9px 14px">${v(body.otpEmail)}</td></tr>
        <tr style="background:#F5F8FA"><td style="padding:9px 14px;color:#8A9BAB;font-size:11px;text-transform:uppercase;letter-spacing:.5px;font-weight:600">Prueba de vida</td><td style="padding:9px 14px">${v(body.liveness)}</td></tr>
        <tr><td style="padding:9px 14px;color:#8A9BAB;font-size:11px;text-transform:uppercase;letter-spacing:.5px;font-weight:600">Selfie</td><td style="padding:9px 14px">${v(body.selfie)}</td></tr>
        <tr style="background:#F5F8FA"><td style="padding:9px 14px;color:#8A9BAB;font-size:11px;text-transform:uppercase;letter-spacing:.5px;font-weight:600">Foto del DNI</td><td style="padding:9px 14px">${v(body.dniFoto)}</td></tr>
      </table>

      ${(body.selfieImg || body.dniFotoImg) ? `
      <div style="background:#EBF4F7;border-radius:10px;padding:14px 16px;font-size:13px;color:#4A6070;margin-bottom:20px">
        📎 Las fotos (selfie${body.dniFotoImg ? ' y DNI' : ''}) van adjuntas a este email.
      </div>` : ''}

      <!-- Footer email -->
      <p style="font-size:11px;color:#8A9BAB;text-align:center;border-top:1px solid #E0E8EC;padding-top:16px;margin:0">
        FirmaYa · London Servicios Inmobiliarios · Caseros 992 Of. B PB, Córdoba
      </p>
    </div>
  </div>
</div>`,
            attachments: []
          };

          // Adjuntar selfie si existe
          if(body.selfieImg){
            const b64 = body.selfieImg.replace(/^data:image\/\w+;base64,/, '');
            emailPayload.attachments.push({
              filename: 'selfie-' + (firmante||'firmante').replace(/\s+/g,'-').toLowerCase() + '.jpg',
              content:  b64,
              content_type: 'image/jpeg'
            });
          }
          // Adjuntar foto DNI si existe
          if(body.dniFotoImg){
            const b64 = body.dniFotoImg.replace(/^data:image\/\w+;base64,/, '');
            emailPayload.attachments.push({
              filename: 'dni-' + (firmante||'firmante').replace(/\s+/g,'-').toLowerCase() + '.jpg',
              content:  b64,
              content_type: 'image/jpeg'
            });
          }

          fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Authorization': 'Bearer ' + env.RESEND_API_KEY,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(emailPayload)
          }).catch(()=>{});
        }

        return json({ ok: true, firmado: true, firmadoEn });

      }catch(e){
        return json({ ok: false, error: e.message }, 500);
      }
    }

    // ── GET /api/check ───────────────────────────────────────────────────────
    if(url.pathname === '/api/check'){
      const token = url.searchParams.get('token');
      if(!token) return json({ firmado: false, error: 'Token requerido' }, 400);
      if(!env.FIRMAYA_KV) return json({ firmado: false, error: 'KV no configurado' });

      try{
        const data = await env.FIRMAYA_KV.get('doc:' + token, 'json');
        if(!data) return json({ firmado: false });
        if(data.estado === 'Firmado'){
          return json({
            firmado: true,
            firmadoEn: data.firmadoEn,
            firmante: data.firmante,
            email: data.email,
            dni: data.dni,
            docNombre: data.docNombre
          });
        }
        return json({ firmado: false, estado: data.estado });
      }catch(e){
        return json({ firmado: false, error: e.message }, 500);
      }
    }

    // ── GET /api/acms?agent=slug ──────────────────────────────────────────────
    if(url.pathname === '/api/acms' && request.method === 'GET'){
      const agent = url.searchParams.get('agent');
      if(!agent) return json({ error: 'agent requerido' }, 400);
      if(!env.FIRMAYA_KV) return json({ acms: [] });
      try {
        const data = await env.FIRMAYA_KV.get('acms__' + agent, 'json');
        return json({ acms: data || [] });
      } catch(e) {
        return json({ acms: [], error: e.message });
      }
    }

    // ── POST /api/acms ─────────────────────────────────────────────────────────
    // body: { agent, entry: { id, ts, label, agente, data } }
    if(url.pathname === '/api/acms' && request.method === 'POST'){
      if(!env.FIRMAYA_KV) return json({ ok: false, error: 'KV no configurado' });
      try {
        const body = await request.json();
        const agent = body.agent;
        const entry = body.entry;
        if(!agent || !entry) return json({ ok: false, error: 'agent y entry requeridos' }, 400);
        let list = await env.FIRMAYA_KV.get('acms__' + agent, 'json') || [];
        list = list.filter(e => e.id !== entry.id); // evitar duplicados
        list.unshift(entry);
        if(list.length > 50) list = list.slice(0, 50);
        await env.FIRMAYA_KV.put('acms__' + agent, JSON.stringify(list));
        return json({ ok: true, count: list.length });
      } catch(e) {
        return json({ ok: false, error: e.message }, 500);
      }
    }

    // ── DELETE /api/acms?agent=slug&id=id ─────────────────────────────────────
    if(url.pathname === '/api/acms' && request.method === 'DELETE'){
      if(!env.FIRMAYA_KV) return json({ ok: false, error: 'KV no configurado' });
      try {
        const agent = url.searchParams.get('agent');
        const id    = parseInt(url.searchParams.get('id'), 10);
        if(!agent || !id) return json({ ok: false, error: 'agent e id requeridos' }, 400);
        let list = await env.FIRMAYA_KV.get('acms__' + agent, 'json') || [];
        list = list.filter(e => e.id !== id);
        await env.FIRMAYA_KV.put('acms__' + agent, JSON.stringify(list));
        return json({ ok: true });
      } catch(e) {
        return json({ ok: false, error: e.message }, 500);
      }
    }

    // ── GET /api/borrador?agent=slug ──────────────────────────────────────────
    if(url.pathname === '/api/borrador' && request.method === 'GET'){
      const agent = url.searchParams.get('agent');
      if(!agent) return json({ error: 'agent requerido' }, 400);
      if(!env.FIRMAYA_KV) return json({ borrador: null });
      try {
        const data = await env.FIRMAYA_KV.get('borrador__' + agent, 'json');
        return json({ borrador: data });
      } catch(e) { return json({ borrador: null, error: e.message }); }
    }

    // ── POST /api/borrador ────────────────────────────────────────────────────
    if(url.pathname === '/api/borrador' && request.method === 'POST'){
      if(!env.FIRMAYA_KV) return json({ ok: false, error: 'KV no configurado' });
      try {
        const body  = await request.json();
        const agent = body.agent;
        const data  = body.data;
        if(!agent || !data) return json({ ok: false, error: 'faltan datos' }, 400);
        await env.FIRMAYA_KV.put('borrador__' + agent, JSON.stringify(data));
        return json({ ok: true });
      } catch(e) { return json({ ok: false, error: e.message }, 500); }
    }

    // ── DELETE /api/borrador?agent=slug ───────────────────────────────────────
    if(url.pathname === '/api/borrador' && request.method === 'DELETE'){
      if(!env.FIRMAYA_KV) return json({ ok: false, error: 'KV no configurado' });
      try {
        const agent = url.searchParams.get('agent');
        if(!agent) return json({ ok: false, error: 'agent requerido' }, 400);
        await env.FIRMAYA_KV.delete('borrador__' + agent);
        return json({ ok: true });
      } catch(e) { return json({ ok: false, error: e.message }, 500); }
    }

    // ── GET /api/registro ─────────────────────────────────────────────────────
    if(url.pathname === '/api/registro' && request.method === 'GET'){
      if(!env.FIRMAYA_KV) return json({ registro: [] });
      try {
        const data = await env.FIRMAYA_KV.get('registro_ventas', 'json');
        return json({ registro: data || [] });
      } catch(e) { return json({ registro: [], error: e.message }); }
    }

    // ── POST /api/registro ────────────────────────────────────────────────────
    if(url.pathname === '/api/registro' && request.method === 'POST'){
      if(!env.FIRMAYA_KV) return json({ ok: false, error: 'KV no configurado' });
      try {
        const body = await request.json();
        const arr  = body.registro;
        if(!Array.isArray(arr)) return json({ ok: false, error: 'registro debe ser array' }, 400);
        // Limitar a 500 registros para no crecer infinito
        const limited = arr.slice(0, 500);
        await env.FIRMAYA_KV.put('registro_ventas', JSON.stringify(limited));
        return json({ ok: true, count: limited.length });
      } catch(e) { return json({ ok: false, error: e.message }, 500); }
    }

    // ── GET /api/photos?token=xxx ─────────────────────────────────────────────
    // Devuelve las fotos (selfie + DNI) guardadas al firmar
    if(url.pathname === '/api/photos' && request.method === 'GET'){
      const token = url.searchParams.get('token');
      if(!token) return json({ ok: false, error: 'token requerido' }, 400);
      if(!env.FIRMAYA_KV) return json({ ok: false, error: 'KV no configurado' }, 500);
      try{
        const data = await env.FIRMAYA_KV.get('photos:' + token, 'json');
        if(!data) return json({ ok: false, error: 'Fotos no encontradas para este token' }, 404);
        return json({ ok: true, selfie: data.selfie, dniFoto: data.dniFoto, firma: data.firma, firmante: data.firmante, guardadoEn: data.guardadoEn });
      }catch(e){ return json({ ok: false, error: e.message }, 500); }
    }

    // ── POST /api/otp/send ─────────────────────────────────────────────────────
    // body: { token, email, nombre }
    // Genera código OTP de 6 dígitos, lo guarda en KV (10 min), lo envía por email
    if(url.pathname === '/api/otp/send' && request.method === 'POST'){
      try{
        const body = await request.json();
        const { token, email, nombre } = body;
        if(!token || !email) return json({ ok: false, error: 'token y email requeridos' }, 400);

        // Generar código de 6 dígitos
        const otp = Math.floor(100000 + Math.random() * 900000).toString();

        // Guardar en KV con TTL de 10 minutos
        if(env.FIRMAYA_KV){
          await env.FIRMAYA_KV.put('otp__' + token + '__' + email.toLowerCase(), otp, { expirationTtl: 600 });
        }

        // Enviar por email con Resend
        if(env.RESEND_API_KEY){
          const r = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Authorization': 'Bearer ' + env.RESEND_API_KEY,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              from: 'FirmaYa <noreply@londonserviciosinmobiliarios.com.ar>',
              to: [email],
              subject: 'Tu código de verificación es: ' + otp,
              html: `
<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;background:#f5f8fa;padding:32px">
  <div style="background:white;border-radius:16px;padding:32px;box-shadow:0 4px 20px rgba(0,0,0,.08)">
    <div style="text-align:center;margin-bottom:24px">
      <div style="font-family:Georgia,serif;font-size:26px;font-weight:700;color:#0D6278">FirmaYa</div>
      <div style="font-size:11px;letter-spacing:2px;color:#8A9BAB;text-transform:uppercase">Verificación de identidad</div>
    </div>
    <h2 style="font-size:18px;color:#1A2B35;margin-bottom:12px">Hola ${nombre || 'firmante'},</h2>
    <p style="color:#4A6070;font-size:14px;line-height:1.6;margin-bottom:24px">
      Recibiste este código porque estás firmando un documento con <strong>London Servicios Inmobiliarios</strong>.
      Ingresalo en la página de firma para verificar tu identidad.
    </p>
    <div style="text-align:center;margin:28px 0">
      <div style="display:inline-block;background:#EBF4F7;border:2px solid #0D6278;border-radius:16px;padding:20px 48px">
        <div style="font-size:40px;font-weight:700;letter-spacing:10px;color:#0D6278;font-family:monospace">${otp}</div>
      </div>
    </div>
    <p style="color:#8A9BAB;font-size:12px;text-align:center;margin-top:16px">
      ⏱️ Este código expira en 10 minutos.<br>
      Si no solicitaste este código, ignorá este email.
    </p>
    <hr style="border:none;border-top:1px solid #D0DDE5;margin:20px 0">
    <p style="color:#8A9BAB;font-size:11px;text-align:center">
      London Servicios Inmobiliarios · Caseros 992 Of. B PB, Córdoba<br>
      Powered by FirmaYa
    </p>
  </div>
</div>`
            })
          });
          let resendData = {};
          try{ resendData = await r.json(); }catch(_){}
          if(!r.ok){
            return json({
              ok: false,
              error: resendData.message || resendData.error || 'Error al enviar email de verificación',
              resendStatus: r.status
            }, 500);
          }
        }

        return json({ ok: true });
      }catch(e){ return json({ ok: false, error: e.message }, 500); }
    }

    // ── POST /api/otp/verify ──────────────────────────────────────────────────
    // body: { token, email, code }
    // Verifica el código OTP; si es correcto lo elimina (uso único)
    if(url.pathname === '/api/otp/verify' && request.method === 'POST'){
      try{
        const body = await request.json();
        const { token, email, code } = body;
        if(!token || !email || !code) return json({ ok: false, error: 'faltan datos' }, 400);
        if(!env.FIRMAYA_KV) return json({ ok: false, error: 'KV no configurado' }, 500);

        const stored = await env.FIRMAYA_KV.get('otp__' + token + '__' + email.toLowerCase());
        if(!stored) return json({ ok: false, error: 'Código expirado. Solicitá uno nuevo.' });
        if(stored !== code.toString().trim()) return json({ ok: false, error: 'Código incorrecto. Revisá e intentá de nuevo.' });

        // Eliminar OTP luego de verificación exitosa (uso único)
        await env.FIRMAYA_KV.delete('otp__' + token + '__' + email.toLowerCase());

        return json({ ok: true });
      }catch(e){ return json({ ok: false, error: e.message }, 500); }
    }

        return new Response('', { status: 200, headers: CORS });
  }
};
