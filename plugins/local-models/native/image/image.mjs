import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { engineEnvironment, resourceDirectory, resourceFile } from '../resources.mjs'
import { checkpointValidationValid } from './recipes.mjs'

export function engineFailureCode(diagnostics) {
  if (/bad_alloc|Cannot allocate memory|failed to allocate|out of (?:device |host )?memory|ErrorOutOfDeviceMemory|CUDA_ERROR_OUT_OF_MEMORY|VK_ERROR_OUT_OF_DEVICE_MEMORY/i.test(diagnostics)) return 'RESOURCE_EXHAUSTED'
  if (/unsupported (?:model|tensor|architecture|weight|quantization)|(?:model|tensor|architecture|quantization)[^\n]*(?:not supported|unsupported)|unknown model type|_weight_qdata|TorchAO/i.test(diagnostics)) return 'UNSUPPORTED'
  return 'FAILED'
}

async function outputPresent(path) {
  try { const file = await stat(path); return file.isFile() && file.size > 0 }
  catch (error) { if (error.code === 'ENOENT') return false; throw error }
}

function fail(call, code) {
  if (!call.emit({ type: 'failed', code, retryable: false })) throw Error('EXTENSION_INFERENCE_CHANNEL_FULL')
}

export function launchConfiguration(input, request, output, platform = process.platform) {
  const { configuration } = input
  const modelFile = role => resourceFile(input, 'model', role)
  const turbo = configuration.imageArchitecture === 'z-image-turbo'
  if (configuration.imageArchitecture === 'checkpoint' && (!checkpointValidationValid(configuration.imageValidation) || typeof configuration.files?.model !== 'string' || !configuration.files.model)) throw Error('EXTENSION_INFERENCE_IMAGE_UNSUPPORTED')
  if (configuration.imageArchitecture && !['checkpoint', 'z-image-turbo'].includes(configuration.imageArchitecture)) throw Error('EXTENSION_INFERENCE_IMAGE_UNSUPPORTED')
  if (['checkpoint', 'z-image-turbo'].includes(configuration.imageArchitecture) && (request.operation !== 'generate' || request.images.length)) throw Error('EXTENSION_INFERENCE_IMAGE_UNSUPPORTED')
  if (turbo && !['diffusion', 'llm', 'vae'].every(role => typeof configuration.files?.[role] === 'string' && configuration.files[role])) throw Error('EXTENSION_INFERENCE_IMAGE_UNSUPPORTED')
  const dimensions = request.output.size === 'auto' ? [512, 512] : request.output.size.split('x').map(Number)
  const weights = configuration.imageArchitecture === 'checkpoint' ? ['-m', modelFile(configuration.files.model)] : turbo ? ['--diffusion-model', modelFile(configuration.files.diffusion), '--llm', modelFile(configuration.files.llm), '--vae', modelFile(configuration.files.vae), '--offload-to-cpu'] : ['--diffusion-model', modelFile('qwen_image_2.1-Q4_K.gguf'), '--vae', modelFile('qwen_image_2.1_vae_bf16.safetensors'), '--llm', modelFile('Qwen3VL-8B-Instruct-Q4_K_M.gguf'), '--llm_vision', modelFile('mmproj-Qwen3VL-8B-Instruct-F16.gguf')]
  const args = [...weights, '--backend', configuration.backend, '--max-vram', String(configuration.vramGiB), '--vae-tiling', '--flash-attn', platform === 'win32' ? 'off,diffusion=on' : platform === 'darwin' ? 'auto' : 'on', '--steps', String(configuration.steps ?? (turbo ? 8 : 20)), '--cfg-scale', turbo ? '1' : '6', '--sampling-method', 'euler', '-W', String(dimensions[0]), '-H', String(dimensions[1]), '-s', String(configuration.seed), '-p', request.prompt, '-o', output]
  const directory = resourceDirectory(input, 'engine')
  const env = platform === 'linux' ? { ...process.env, LD_LIBRARY_PATH: directory } : engineEnvironment(directory, platform)
  return { executable: resourceFile(input, 'engine', platform === 'win32' ? 'sd-cli.exe' : 'sd-cli'), args, options: { cwd: directory, env, windowsHide: true, stdio: /** @type {['ignore', 'pipe', 'pipe']} */ (['ignore', 'pipe', 'pipe']) } }
}

export async function initialize(options) {
  return { start(_capability,_input,call) {
    const chunks=[]; let size=0
    return { write(bytes){size+=bytes.length;if(size>32*1024*1024)throw Error('EXTENSION_INFERENCE_INPUT_TOO_LARGE');chunks.push(Buffer.from(bytes))}, async finish(){
      const request=JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const directory=await mkdtemp(join(tmpdir(),'image-')),output=join(directory,'output.png')
      const dimensions=request.output.size==='auto'?[512,512]:request.output.size.split('x').map(Number)
      try{
        call.signal.throwIfAborted()
        let launch
        try { launch=launchConfiguration(options,request,output) }
        catch (error) { if (error.message === 'EXTENSION_INFERENCE_IMAGE_UNSUPPORTED') { fail(call,'UNSUPPORTED'); return } throw error }
        const args=launch.args
        for(const [index,image] of request.images.entries()){const file=join(directory,`reference-${index}.png`);await writeFile(file,Buffer.from(image.data,'base64'));args.push('-r',file)}
        call.signal.throwIfAborted()
        if(!call.emit({type:'submitted',requestId:request.requestId}))throw Error('EXTENSION_INFERENCE_CHANNEL_FULL')
        const started=Date.now();process.stderr.write('\n'+JSON.stringify({event:'image.start',id:request.requestId,operation:request.operation,references:request.images.length,size:dimensions,at:Date.now()})+'\n')
        const child=spawn(launch.executable,args,launch.options)
        let errors=''
        const observe=bytes=>errors=(errors+bytes).slice(-16000)
        child.stderr.on('data',observe);child.stdout.on('data',observe)
        child.stdout.pipe(process.stderr,{end:false});child.stderr.pipe(process.stderr,{end:false})
        let timer;const cancel=()=>{child.kill('SIGTERM');timer=setTimeout(()=>child.kill('SIGKILL'),4000)}
        call.signal.addEventListener('abort',cancel,{once:true});if(call.signal.aborted)cancel()
        let exit
        try{exit=await new Promise((resolve,reject)=>{child.once('error',error=>child.pid ? reject(error) : resolve({code:null,signal:null,spawnError:'code' in error ? error.code : 'SPAWN_FAILED'}));child.once('close',(code,signal)=>resolve({code,signal}))})}
        finally{clearTimeout(timer);call.signal.removeEventListener('abort',cancel)}
        process.stderr.write('\n'+JSON.stringify({event:'image.exit',id:request.requestId,...exit,at:Date.now(),ms:Date.now()-started})+'\n')
        call.signal.throwIfAborted()
        const present=await outputPresent(output)
        if(exit.code!==0 || !present){
          const code=engineFailureCode(errors)
          process.stderr.write('\n'+JSON.stringify({event:'image.failure',id:request.requestId,code,outputPresent:present})+'\n')
          // A missing local artifact or exit code alone cannot establish that generation failed.
          if(!present && (exit.spawnError || code!=='FAILED')){fail(call,code);return}
          throw Error('EXTENSION_INFERENCE_BACKEND_FAILED')
        }
        const bytes=await readFile(output)
        for(let offset=0,sequence=0;offset<bytes.length;offset+=256*1024,sequence++){
          if(!call.emit({type:'image',index:0,sequence,final:offset+256*1024>=bytes.length,mimeType:'image/png'},bytes.subarray(offset,offset+256*1024)))throw Error('EXTENSION_INFERENCE_CHANNEL_FULL')
          await new Promise(resolve=>setImmediate(resolve))
        }
        call.emit({type:'done',responseId:request.requestId})
        process.stderr.write('\n'+JSON.stringify({event:'image.done',id:request.requestId,ms:Date.now()-started,bytes:bytes.length})+'\n')
      }finally{await rm(directory,{recursive:true,force:true})}
    }}
  }}
}
