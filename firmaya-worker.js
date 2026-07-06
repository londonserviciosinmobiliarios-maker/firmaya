// FirmaYa Worker  restored 2026-07-05 — Cloudflare Worker
// Endpoints:
//   POST /api/send    → registra doc en KV y envía email al firmante (opcional)
//   POST /api/upload  → sube archivo del doc a KV para que el cliente lo vea
//   GET  /api/file    → sirve el archivo del doc desde KV
//   POST /api/sign    → registra la firma (guarda en KV)
//   GET  /api/check   → consulta si un token fue firmado
//
// KV Binding requerido: FIRMAYA_KV
// Secret requerido:     RESEND_API_KEY

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status=200){
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if(request.method === 'OPTIONS'){
      return new Response(null, { status: 204, headers: CORS });
    }

    // ── POST /api/send ────────────────────────────────────────────────────────
    // Registra el documento en KV y OPCIONALMENTE envía email
    if(url.pathname === '/api/send' && request.method === 'POST'){
      try{
        const body = await request.json();
        const { token, docNombre, firmante, emailFirmante, firmarUrl, sendEmail } = body;
        if(!token || !firmarUrl) return json({ok:false, error:'Faltan datos'}, 400);

        // Siempre guardar en KV (funciona para email Y WhatsApp)
        if(env.FIRMAYA_KV){
          await env.FIRMAYA_KV.put('doc:' + token, JSON.stringify({
            token, docNombre, firmante, emailFirmante, firmarUrl,
            estado: 'Pendiente',
            creadoEn: new Date().toISOString()
          }), { expirationTtl: 60 * 60 * 24 * 90 });
        }

        // Solo enviar email si se pide y hay email
        if(sendEmail !== false && emailFirmante && env.RESEND_API_KEY){
          const emailResp = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Authorization': 'Bearer ' + env.RESEND_API_KEY,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              from: 'FirmaYa <noreply@firmaya.londonserviciosinmobiliarios.com.ar>',
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
          const emailData = await emailResp.json();
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
        const { token, firmante, email, dni, lat, lng, ip, device, docNombre, sigPos } = body;
        if(!token) return json({ok:false, error:'Token requerido'}, 400);

        // Capturar IP real desde Cloudflare si el cliente no la envió
        const clientIp = ip || request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'desconocida';

        const firmadoEn = new Date().toISOString();

        if(env.FIRMAYA_KV){
          const existing = await env.FIRMAYA_KV.get('doc:' + token, 'json');
          const docData = existing || { token, docNombre };
          docData.estado = 'Firmado';
          docData.firmante = firmante;
          docData.email = email;
          docData.dni = dni;
          docData.firmadoEn = firmadoEn;
          docData.lat = lat;
          docData.lng = lng;
          docData.ip = clientIp;
          docData.device = device;
          if(sigPos) docData.sigPos = sigPos;
          await env.FIRMAYA_KV.put('doc:' + token, JSON.stringify(docData), { expirationTtl: 60 * 60 * 24 * 365 });
        }

        // Notificar al agente
        if(env.RESEND_API_KEY){
          const docNombreFinal = docNombre || token;
          fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Authorization': 'Bearer ' + env.RESEND_API_KEY,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              from: 'FirmaYa <noreply@firmaya.londonserviciosinmobiliarios.com.ar>',
              to: ['londonserviciosinmobiliarios@gmail.com'],
              subject: '✅ Documento firmado: ' + docNombreFinal,
              html: `
<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;background:#f5f8fa;padding:32px">
  <div style="background:white;border-radius:16px;padding:32px">
    <div style="text-align:center;margin-bottom:20px">
      <div style="font-size:48px">✅</div>
      <div style="font-family:Georgia,serif;font-size:22px;font-weight:700;color:#0D6278">Documento Firmado</div>
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      <tr><td style="padding:8px;color:#8A9BAB;width:40%">Firmante</td><td style="padding:8px;font-weight:600">${firmante}</td></tr>
      <tr style="background:#f5f8fa"><td style="padding:8px;color:#8A9BAB">DNI</td><td style="padding:8px;font-weight:600">${dni||'—'}</td></tr>
      <tr><td style="padding:8px;color:#8A9BAB">Email</td><td style="padding:8px;font-weight:600">${email}</td></tr>
      <tr style="background:#f5f8fa"><td style="padding:8px;color:#8A9BAB">Documento</td><td style="padding:8px;font-weight:600">${docNombreFinal}</td></tr>
      <tr><td style="padding:8px;color:#8A9BAB">Fecha y hora</td><td style="padding:8px;font-weight:600">${new Date(firmadoEn).toLocaleString('es-AR')}</td></tr>
      <tr style="background:#f5f8fa"><td style="padding:8px;color:#8A9BAB">Token</td><td style="padding:8px;font-weight:600;font-size:12px">${token}</td></tr>
    </table>
    <p style="color:#8A9BAB;font-size:12px;text-align:center;margin-top:20px">
      Ingresá al panel FirmaYa para ver el documento y el comprobante de firma.
    </p>
  </div>
</div>`
            })
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

    // ── GET /api/doc ─────────────────────────────────────────────────────────
    // Devuelve todos los metadatos del doc (incluyendo evidencia de firma)
    if(url.pathname === '/api/doc'){
      const token = url.searchParams.get('token');
      if(!token) return json({ ok: false, error: 'Token requerido' }, 400);
      if(!env.FIRMAYA_KV) return json({ ok: false, error: 'KV no configurado' });
      try{
        const data = await env.FIRMAYA_KV.get('doc:' + token, 'json');
        if(!data) return json({ ok: false, error: 'Documento no encontrado' }, 404);
        return json({
          ok: true,
          token:      data.token,
          nombre:     data.docNombre || data.fileNombre || data.nombre,
          firmante:   data.firmante,
          email:      data.email || data.emailFirmante,
          dni:        data.dni,
          estado:     data.estado,
          creadoEn:   data.creadoEn,
          firmadoEn:  data.firmadoEn,
          lat:        data.lat,
          lng:        data.lng,
          ip:         data.ip,
          device:     data.device,
          fileMime:   data.fileMime
        });
      }catch(e){
        return json({ ok: false, error: e.message }, 500);
      }
    }

    // ── GET /api/list ─────────────────────────────────────────────────────────
    // Lista todos los documentos guardados en KV
    if(url.pathname === '/api/list'){
      if(!env.FIRMAYA_KV) return json({ ok: false, error: 'KV no configurado' });
      try{
        const list = await env.FIRMAYA_KV.list({ prefix: 'doc:' });
        const docs = await Promise.all(
          list.keys.map(k => env.FIRMAYA_KV.get(k.name, 'json'))
        );
        // Ordenar por fecha de creación (más reciente primero)
        const sorted = docs.filter(Boolean).sort((a, b) => {
          const ta = a.creadoEn ? new Date(a.creadoEn).getTime() : 0;
          const tb = b.creadoEn ? new Date(b.creadoEn).getTime() : 0;
          return tb - ta;
        });
        return json({ ok: true, docs: sorted });
      }catch(e){ return json({ ok: false, error: e.message }, 500); }
    }

    
  // DELETE one document
  if (pathname === '/api/delete') {
    const token = url.searchParams.get('token');
    if (!token) return new Response('Missing token', { status: 400, headers: corsHeaders });
    await env.FIRMAYA_KV.delete('doc:' + token);
    await env.FIRMAYA_KV.delete('file:' + token);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  // DELETE ALL documents (admin reset)
  if (pathname === '/api/deleteAll') {
    let cursor = undefined;
    let totalDeleted = 0;
    do {
      const listRes = await env.FIRMAYA_KV.list({ cursor, limit: 100 });
      for (const key of listRes.keys) {
        await env.FIRMAYA_KV.delete(key.name);
        totalDeleted++;
      }
      cursor = listRes.list_complete ? undefined : listRes.cursor;
    } while (cursor);
    return new Response(JSON.stringify({ ok: true, deleted: totalDeleted }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

return new Response('', { status: 200, headers: CORS });
  }
};
