import { Buffer } from 'node:buffer'
export async function initialize({ configuration }) {
  return { start(_capability, _input, call) {
    const chunks=[]; let size=0
    return { write(bytes){size+=bytes.length;if(size>32*1024*1024)throw Error('EXTENSION_INFERENCE_INPUT_TOO_LARGE');chunks.push(Buffer.from(bytes))}, async finish(){
      const request=JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const fields={model:configuration.model,prompt:request.prompt,n:'1',size:request.output.size==='auto'?configuration.defaultSize:request.output.size,...(configuration.responseMode==='png'?{output_format:'png'}:{response_format:'b64_json'})}
      const editing=request.operation==='edit'
      let body, options={}
      if(editing){
        const form=new FormData()
        for(const[key,value]of Object.entries(fields))form.append(key,value)
        for(const[index,image]of request.images.entries())form.append('image[]',new Blob([Buffer.from(image.data,'base64')],{type:image.mimeType}),`reference-${index}.${image.mimeType.split('/')[1]}`)
        const encoded=new Request('http://127.0.0.1/',{method:'POST',body:form})
        body=new Uint8Array(await encoded.arrayBuffer());options={contentType:encoded.headers.get('content-type')}
      }else body=new TextEncoder().encode(JSON.stringify({...fields,n:1}))
      const started=Date.now()
      process.stderr.write(JSON.stringify({event:'image.api.start',id:request.requestId,operation:request.operation,references:request.images.length,bytes:body.length})+'\n')
      call.signal.throwIfAborted()
      if(!call.emit({type:'submitted',requestId:request.requestId}))throw Error('EXTENSION_INFERENCE_CHANNEL_FULL')
      const response=await call.network.post(editing?'edit':'generate',body,options)
      const responseId=response.headers.get('x-request-id')??request.requestId
      if(!call.emit({type:'submitted',requestId:responseId}))throw Error('EXTENSION_INFERENCE_CHANNEL_FULL')
      if(!response.ok){
        await response.body?.cancel()
        if([400,401,403,404,429].includes(response.status)){call.emit({type:'failed',code:response.status===429?'BUSY':'UNAVAILABLE',retryable:response.status!==400});return}
        throw Error('EXTENSION_INFERENCE_IMAGE_RESULT_UNKNOWN')
      }
      const result=await response.json()
      if(!Array.isArray(result.data)||result.data.length!==1||typeof result.data[0]?.b64_json!=='string')throw Error('EXTENSION_INFERENCE_IMAGE_RESULT_UNKNOWN')
      const bytes=Buffer.from(result.data[0].b64_json,'base64')
      if(!bytes.length||bytes.length>32*1024*1024)throw Error('EXTENSION_INFERENCE_IMAGE_RESULT_UNKNOWN')
      call.signal.throwIfAborted()
      for(let offset=0,sequence=0;offset<bytes.length;offset+=256*1024,sequence++){
        if(!call.emit({type:'image',index:0,sequence,final:offset+256*1024>=bytes.length,mimeType:'image/png'},bytes.subarray(offset,offset+256*1024)))throw Error('EXTENSION_INFERENCE_CHANNEL_FULL')
        await new Promise(resolve=>setImmediate(resolve))
      }
      call.emit({type:'done',responseId})
      process.stderr.write(JSON.stringify({event:'image.api.done',id:request.requestId,ms:Date.now()-started,bytes:bytes.length})+'\n')
    }}
  }}
}
