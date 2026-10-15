import type {HtmlPcmPacket} from '../../shared/html-surface';
export type {HtmlPcmPacket} from '../../shared/html-surface';

/** Source PCM reaches this client graph after a real client gesture resumes it. */
export class HtmlPcmPlayer {
  private context?:AudioContext;
  private sources=new Set<AudioBufferSourceNode>();
  private instanceId?:string;
  private sequence=0;
  private engineOrigin=0;
  private playbackOrigin=0;
  private until=0;
  private stopped=false;
  constructor(private makeContext:()=>AudioContext=()=>new AudioContext(),private outputNode?:(context:AudioContext)=>AudioNode){}
  resume():Promise<void>{
    if(this.stopped)return Promise.reject(new Error('The HTML audio surface is closed.'));
    this.context??=this.makeContext();return this.context.resume();
  }
  private reset(instanceId:string){
    for(const source of this.sources){try{source.stop()}catch{}source.disconnect()}this.sources.clear();
    this.instanceId=instanceId;this.sequence=0;this.engineOrigin=0;this.playbackOrigin=0;this.until=0;
  }
  clear():void{this.reset('');}
  push(instanceId:string,packets:readonly HtmlPcmPacket[]):void{
    if(this.stopped)return;
    if(this.instanceId!==instanceId)this.reset(instanceId);
    const context=this.context;
    const newest=packets.at(-1)?.pts;
    for(const packet of packets){
      if(!Number.isSafeInteger(packet.audioSeq)||packet.audioSeq<1||packet.audioSeq<=this.sequence)continue;
      if(!Number.isInteger(packet.channels)||packet.channels<1||packet.channels>8||!Number.isInteger(packet.frames)||packet.frames<1||packet.frames>8192||!Number.isInteger(packet.sampleRate)||packet.sampleRate<8000||packet.sampleRate>192000||!Number.isFinite(packet.pts))throw new Error('The HTML audio packet is invalid.');
      this.sequence=packet.audioSeq;
      if(!context||context.state!=='running')continue;
      if(newest!==undefined&&packet.pts<newest-350)continue;
      const raw=Uint8Array.from(atob(packet.pcmBase64),value=>value.charCodeAt(0));
      if(raw.byteLength!==packet.channels*packet.frames*4)throw new Error('The HTML audio packet size is invalid.');
      const floats=new Float32Array(raw.buffer);
      if(floats.some(value=>!Number.isFinite(value)))throw new Error('The HTML audio samples are invalid.');
      if(!this.engineOrigin||this.until<context.currentTime-.1){this.engineOrigin=packet.pts;this.playbackOrigin=context.currentTime+.05;}
      const target=this.playbackOrigin+(packet.pts-this.engineOrigin)/1000;
      if(target+packet.frames/packet.sampleRate<context.currentTime-.08)continue;
      const start=Math.max(context.currentTime,this.until,target);if(start>context.currentTime+.5)continue;
      const buffer=context.createBuffer(packet.channels,packet.frames,packet.sampleRate);
      for(let channel=0;channel<packet.channels;channel++)buffer.copyToChannel(floats.subarray(channel*packet.frames,(channel+1)*packet.frames),channel);
      const source=context.createBufferSource();source.buffer=buffer;source.connect(this.outputNode?.(context)??context.destination);this.sources.add(source);
      source.onended=()=>{this.sources.delete(source);source.disconnect()};source.start(start);this.until=start+buffer.duration;
    }
  }
  async close():Promise<void>{if(this.stopped)return;this.stopped=true;this.reset('');await this.context?.close();this.context=undefined;}
}
