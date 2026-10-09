#import <Cocoa/Cocoa.h>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>
#include <vector>
#if defined(ACANVAS_TEST_CLIPBOARD_TRIPWIRE)
#import <objc/runtime.h>
#include <atomic>
#include <execinfo.h>
#include <map>
std::atomic<int> pasteboard_calls{0};
std::atomic<int> pasteboard_reads{0},pasteboard_writes{0};
std::atomic<int> pasteboard_names{0},pasteboard_sequences{0},pasteboard_access_policy{0};
std::atomic<int> named_pasteboard_factories{0},find_pasteboard_factories{0},find_pasteboard_reads{0},find_pasteboard_writes{0};
std::atomic<int> host_find_pre_events{0},host_find_post_events{0};
std::mutex tripwire_mutex;
std::vector<std::string> pasteboard_stacks;
std::map<std::string,int> unknown_pasteboard_selectors;
std::map<std::string,std::string> unknown_pasteboard_types;
std::vector<std::string> unknown_pasteboard_stacks;
id FakeMarkerHandle();
id DenyGeneralPasteboard(id,SEL){++pasteboard_calls;void* frames[12];const auto count=backtrace(frames,12);char** symbols=backtrace_symbols(frames,count);{std::lock_guard<std::mutex>lock(tripwire_mutex);std::string stack;std::cerr<<"PASTEBOARD_FACTORY_TRIPWIRE"<<std::endl;for(int i=0;i<count;++i){std::cerr<<symbols[i]<<std::endl;stack+=symbols[i];stack+='\n';}if(pasteboard_stacks.size()<32)pasteboard_stacks.push_back(stack);}free(symbols);
#if defined(ACANVAS_TEST_CLIPBOARD_FAKE_HANDLE)
return FakeMarkerHandle();
#else
return nil;
#endif
}
id DenyPasteboardRead(id,SEL,...){++pasteboard_reads;return nil;}
NSUInteger DenyPasteboardWrite(id,SEL,...){++pasteboard_writes;return 0;}
id DenyNamedPasteboard(id,SEL,...){++named_pasteboard_factories;return nil;}
id DenyFindPasteboard(id,SEL,...){++find_pasteboard_factories;return nil;}
id DenyFindRead(id,SEL,...){++find_pasteboard_reads;return nil;}
void DenyFindWrite(id,SEL,...){++find_pasteboard_writes;}
void InstallClipboardTripwire(){const auto cls=NSClassFromString(@"NSPasteboard");const auto target=class_getClassMethod(cls,@selector(generalPasteboard));method_setImplementation(target,reinterpret_cast<IMP>(DenyGeneralPasteboard));for(const auto name:{"pasteboardWithName:","pasteboardWithUniqueName"}){const auto method=class_getClassMethod(cls,sel_registerName(name));if(method)method_setImplementation(method,reinterpret_cast<IMP>(DenyNamedPasteboard));}for(const auto name:{"dataForType:","stringForType:","types","pasteboardItems","readObjectsForClasses:options:","propertyListForType:"}){const auto method=class_getInstanceMethod(cls,sel_registerName(name));if(method)method_setImplementation(method,reinterpret_cast<IMP>(DenyPasteboardRead));}for(const auto name:{"clearContents","writeObjects:","setData:forType:","setString:forType:","declareTypes:owner:","addTypes:owner:","setPropertyList:forType:"}){const auto method=class_getInstanceMethod(cls,sel_registerName(name));if(method)method_setImplementation(method,reinterpret_cast<IMP>(DenyPasteboardWrite));}}
void InstallFindTripwire(){const auto cls=NSClassFromString(@"FindPasteboard");if(!cls)return;const auto factory=class_getClassMethod(cls,sel_registerName("sharedInstance"));if(factory)method_setImplementation(factory,reinterpret_cast<IMP>(DenyFindPasteboard));const auto read=class_getInstanceMethod(cls,sel_registerName("findText"));if(read)method_setImplementation(read,reinterpret_cast<IMP>(DenyFindRead));const auto write=class_getInstanceMethod(cls,sel_registerName("setFindText:"));if(write)method_setImplementation(write,reinterpret_cast<IMP>(DenyFindWrite));}
@interface PrivateMarkerPasteboard : NSObject
@end
@implementation PrivateMarkerPasteboard
- (NSString*)name {++pasteboard_names;return @"acanvas-owned-test-marker";}
- (NSInteger)changeCount {++pasteboard_sequences;return 17;}
- (NSInteger)accessBehavior {++pasteboard_access_policy;return 0;}
- (NSArray*)types {++pasteboard_reads;return @[NSPasteboardTypeString];}
- (NSArray*)pasteboardItems {++pasteboard_reads;return @[];}
- (NSString*)stringForType:(NSString*)type {++pasteboard_reads;return @"FAKE_OWNED_PASTEBOARD";}
- (NSData*)dataForType:(NSString*)type {++pasteboard_reads;return [@"FAKE_OWNED_PASTEBOARD" dataUsingEncoding:NSUTF8StringEncoding];}
- (id)propertyListForType:(NSString*)type {++pasteboard_reads;return @"FAKE_OWNED_PASTEBOARD";}
- (NSArray*)readObjectsForClasses:(NSArray*)classes options:(NSDictionary*)options {++pasteboard_reads;return @[];}
- (NSInteger)clearContents {++pasteboard_writes;return 18;}
- (BOOL)writeObjects:(NSArray*)objects {++pasteboard_writes;return YES;}
- (BOOL)setString:(NSString*)string forType:(NSString*)type {++pasteboard_writes;return YES;}
- (BOOL)setData:(NSData*)data forType:(NSString*)type {++pasteboard_writes;return YES;}
- (NSInteger)declareTypes:(NSArray*)types owner:(id)owner {++pasteboard_writes;return 18;}
- (NSInteger)addTypes:(NSArray*)types owner:(id)owner {++pasteboard_writes;return 18;}
- (BOOL)setPropertyList:(id)data forType:(NSString*)type {++pasteboard_writes;return YES;}
- (NSMethodSignature*)methodSignatureForSelector:(SEL)selector {const auto method=class_getInstanceMethod(NSClassFromString(@"NSPasteboard"),selector);if(!method){std::lock_guard<std::mutex>lock(tripwire_mutex);++unknown_pasteboard_selectors[sel_getName(selector)];unknown_pasteboard_types[sel_getName(selector)]="unavailable";return nil;}const auto types=method_getTypeEncoding(method);{std::lock_guard<std::mutex>lock(tripwire_mutex);unknown_pasteboard_types[sel_getName(selector)]=types;}return [NSMethodSignature signatureWithObjCTypes:types];}
- (void)forwardInvocation:(NSInvocation*)invocation {void*frames[16];const auto count=backtrace(frames,16);char**symbols=backtrace_symbols(frames,count);{std::lock_guard<std::mutex>lock(tripwire_mutex);const auto name=sel_getName(invocation.selector);++unknown_pasteboard_selectors[name];std::string stack=name;stack+='\n';for(int i=0;i<count;++i){stack+=symbols[i];stack+='\n';}if(unknown_pasteboard_stacks.size()<32)unknown_pasteboard_stacks.push_back(stack);}free(symbols);const auto length=invocation.methodSignature.methodReturnLength;if(length){std::vector<unsigned char> value(length,0);[invocation setReturnValue:value.data()];}}
@end
id FakeMarkerHandle(){static PrivateMarkerPasteboard*marker=[[PrivateMarkerPasteboard alloc]init];return marker;}
#endif
#include "include/cef_app.h"
#include "include/cef_application_mac.h"
#include "include/cef_audio_handler.h"
#include "include/cef_browser.h"
#include "include/cef_client.h"
#include "include/cef_command_line.h"
#include "include/cef_keyboard_handler.h"
#include "include/cef_context_menu_handler.h"
#include "include/cef_dialog_handler.h"
#include "include/cef_permission_handler.h"
#include "include/cef_download_handler.h"
#include "include/cef_jsdialog_handler.h"
#include "include/cef_request_handler.h"
#include "include/cef_devtools_message_observer.h"
#include "include/cef_image.h"
#include "include/cef_parser.h"
#include "include/cef_render_handler.h"
#include "include/cef_task.h"
#include "include/wrapper/cef_helpers.h"
#include "include/wrapper/cef_library_loader.h"

std::mutex output_mutex;
void Emit(CefRefPtr<CefDictionaryValue> message) {
  auto value = CefValue::Create(); value->SetDictionary(message);
  std::lock_guard<std::mutex> lock(output_mutex);
  std::cout << CefWriteJSON(value, JSON_WRITER_DEFAULT).ToString() << std::endl;
}
CefRefPtr<CefDictionaryValue> Event(const std::string& type) {
  auto event = CefDictionaryValue::Create(); event->SetString("type", type); return event;
}

class SurfaceHandler : public CefClient, public CefRenderHandler,
                       public CefLifeSpanHandler, public CefAudioHandler,
                       public CefLoadHandler, public CefDevToolsMessageObserver,public CefKeyboardHandler,public CefContextMenuHandler,public CefDialogHandler,public CefPermissionHandler,public CefDownloadHandler,public CefJSDialogHandler,public CefRequestHandler {
 public:
  SurfaceHandler(int width, int height, double scale) : width_(width), height_(height),scale_(scale) {}
  CefRefPtr<CefRenderHandler> GetRenderHandler() override { return this; }
  CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }
  CefRefPtr<CefAudioHandler> GetAudioHandler() override { return this; }
  CefRefPtr<CefLoadHandler> GetLoadHandler() override { return this; }
  CefRefPtr<CefKeyboardHandler> GetKeyboardHandler() override {return this;}
  CefRefPtr<CefContextMenuHandler> GetContextMenuHandler() override {return this;}
  CefRefPtr<CefDialogHandler> GetDialogHandler()override{return this;}
  CefRefPtr<CefPermissionHandler> GetPermissionHandler()override{return this;}
  CefRefPtr<CefDownloadHandler> GetDownloadHandler()override{return this;}
  CefRefPtr<CefJSDialogHandler> GetJSDialogHandler()override{return this;}
  CefRefPtr<CefRequestHandler> GetRequestHandler()override{return this;}
  void OnRenderProcessTerminated(CefRefPtr<CefBrowser>,TerminationStatus status,int,const CefString&)override{auto event=Event("renderer-terminated");event->SetInt("status",status);Emit(event);Close();}
  bool OnFileDialog(CefRefPtr<CefBrowser>,FileDialogMode,const CefString&,const CefString&,const std::vector<CefString>&,const std::vector<CefString>&,const std::vector<CefString>&,CefRefPtr<CefFileDialogCallback>callback)override{callback->Cancel();Emit(Event("file-dialog-canceled"));return true;}
  bool OnRequestMediaAccessPermission(CefRefPtr<CefBrowser>,CefRefPtr<CefFrame>,const CefString&,uint32_t,CefRefPtr<CefMediaAccessCallback>callback)override{callback->Cancel();return true;}
  bool OnShowPermissionPrompt(CefRefPtr<CefBrowser>,uint64_t,const CefString&,uint32_t,CefRefPtr<CefPermissionPromptCallback>callback)override{callback->Continue(CEF_PERMISSION_RESULT_DENY);return true;}
  bool CanDownload(CefRefPtr<CefBrowser>,const CefString&,const CefString&)override{return false;}
  bool OnBeforeDownload(CefRefPtr<CefBrowser>,CefRefPtr<CefDownloadItem>,const CefString&,CefRefPtr<CefBeforeDownloadCallback>)override{return true;}
  bool OnJSDialog(CefRefPtr<CefBrowser>,const CefString&,JSDialogType,const CefString&,const CefString&,CefRefPtr<CefJSDialogCallback>,bool&suppress)override{suppress=true;return false;}
  bool OnBeforeUnloadDialog(CefRefPtr<CefBrowser>,const CefString&,bool,CefRefPtr<CefJSDialogCallback>callback)override{callback->Continue(true,CefString());return true;}
  bool HostFindShortcut(const CefKeyEvent& event){return (event.modifiers&EVENTFLAG_COMMAND_DOWN)&&event.windows_key_code=='E';}
  bool HostCommandShortcut(const CefKeyEvent&event){return event.modifiers&EVENTFLAG_COMMAND_DOWN;}
  bool OnPreKeyEvent(CefRefPtr<CefBrowser>,const CefKeyEvent&event,CefEventHandle,bool*shortcut)override {if(HostCommandShortcut(event)){*shortcut=true;
#if defined(ACANVAS_TEST_CLIPBOARD_TRIPWIRE)
  if(HostFindShortcut(event))++host_find_pre_events;
#endif
  }return false;}
  bool OnKeyEvent(CefRefPtr<CefBrowser>,const CefKeyEvent&event,CefEventHandle)override{const auto host_find=HostFindShortcut(event);
#if defined(ACANVAS_TEST_CLIPBOARD_TRIPWIRE)
  if(host_find)++host_find_post_events;
#endif
  return HostCommandShortcut(event);}
  void OnBeforeContextMenu(CefRefPtr<CefBrowser>,CefRefPtr<CefFrame>,CefRefPtr<CefContextMenuParams>,CefRefPtr<CefMenuModel>model)override {model->Clear();}
  void GetViewRect(CefRefPtr<CefBrowser>, CefRect& rect) override { rect = CefRect(0, 0, width_, height_); }
  bool GetScreenInfo(CefRefPtr<CefBrowser>,CefScreenInfo& screen) override { screen.device_scale_factor=scale_;screen.rect=CefRect(0,0,width_,height_);screen.available_rect=screen.rect;return true; }
  void OnPopupShow(CefRefPtr<CefBrowser>,bool show) override { popup_visible_=show;++popup_seq_;if(!show){popup_pixels_.clear();ReplyPopupComposition();} }
  void OnPopupSize(CefRefPtr<CefBrowser>,const CefRect& rect) override { popup_rect_=rect;++popup_seq_; }
  void OnPaint(CefRefPtr<CefBrowser>, PaintElementType type, const RectList&, const void* pixels, int width, int height) override {
    const auto* start = static_cast<const unsigned char*>(pixels);
    if(type==PET_POPUP){popup_width_=width;popup_height_=height;popup_pixels_.assign(start,start+width*height*4);++popup_seq_;ReplyPopupComposition();return;}
    pixel_width_ = width; pixel_height_ = height;
    pixels_.assign(start, start + width * height * 4);
    auto message = Event("paint"); message->SetInt("frameSeq", ++paint_seq_); message->SetInt("width", width); message->SetInt("height", height); Emit(message);
  }
  void OnAfterCreated(CefRefPtr<CefBrowser> browser) override {
    browser_ = browser;
    observer_ = browser->GetHost()->AddDevToolsMessageObserver(this);
    auto message = Event("ready"); message->SetBool("windowless", browser->GetHost()->IsWindowRenderingDisabled()); Emit(message);
  }
  void OnBeforeClose(CefRefPtr<CefBrowser>) override { observer_ = nullptr; browser_ = nullptr; CefQuitMessageLoop(); }
  void OnLoadEnd(CefRefPtr<CefBrowser>, CefRefPtr<CefFrame> frame, int status) override {
    if (frame->IsMain()) { auto message = Event("load"); message->SetInt("status", status); Emit(message); }
    else {auto message=Event("document-load");message->SetInt("status",status);Emit(message);}
  }
  void OnLoadError(CefRefPtr<CefBrowser>,CefRefPtr<CefFrame>,ErrorCode code,const CefString& message,const CefString&) override { auto event=Event("load-error");event->SetInt("code",code);event->SetString("message",message);Emit(event); }
  void OnLoadingStateChange(CefRefPtr<CefBrowser>,bool loading,bool,bool) override { auto event=Event("loading");event->SetBool("loading",loading);Emit(event); }
  bool GetAudioParameters(CefRefPtr<CefBrowser>, CefAudioParameters& params) override {
    params.channel_layout = CEF_CHANNEL_LAYOUT_STEREO; params.sample_rate = 48000; params.frames_per_buffer = 1024; return true;
  }
  void OnAudioStreamStarted(CefRefPtr<CefBrowser>, const CefAudioParameters& params, int channels) override {
    channels_ = channels; sample_rate_ = params.sample_rate;
    auto message = Event("audio-start"); message->SetInt("channels", channels); message->SetInt("sampleRate", sample_rate_); Emit(message);
  }
  void OnAudioStreamPacket(CefRefPtr<CefBrowser>, const float** data, int frames, int64_t pts) override {
    std::vector<float> packet(frames * channels_);
    for (int channel = 0; channel < channels_; ++channel) std::copy(data[channel], data[channel] + frames, packet.begin() + channel * frames);
    auto message = Event("audio"); message->SetInt("channels", channels_); message->SetInt("sampleRate", sample_rate_); message->SetInt("frames", frames); message->SetDouble("pts", static_cast<double>(pts)); message->SetString("pcm", CefBase64Encode(packet.data(), packet.size() * sizeof(float))); Emit(message);
  }
  void OnAudioStreamStopped(CefRefPtr<CefBrowser>) override { Emit(Event("audio-stop")); }
  void OnAudioStreamError(CefRefPtr<CefBrowser>, const CefString& error) override { auto message=Event("audio-error");message->SetString("message",error);Emit(message); }
  void Close() { if (browser_) browser_->GetHost()->CloseBrowser(true); }
  void ReplyPopupComposition(){
    if(!composition_id_)return;auto rendered=composition_pixels_;const auto width=composition_width_,height=composition_height_;
    const auto has_popup=popup_visible_&&!popup_pixels_.empty();
    if(has_popup){const int left=static_cast<int>(popup_rect_.x*scale_),top=static_cast<int>(popup_rect_.y*scale_);for(int y=0;y<popup_height_;++y)for(int x=0;x<popup_width_;++x){const int dx=left+x,dy=top+y;if(dx<0||dy<0||dx>=width||dy>=height)continue;const int source=(y*popup_width_+x)*4,target=(dy*width+dx)*4,alpha=popup_pixels_[source+3];for(int c=0;c<3;c++)rendered[target+c]=popup_pixels_[source+c]+rendered[target+c]*(255-alpha)/255;rendered[target+3]=alpha+rendered[target+3]*(255-alpha)/255;}}
    auto image=CefImage::CreateImage();image->AddBitmap(1.f,width,height,CEF_COLOR_TYPE_BGRA_8888,CEF_ALPHA_TYPE_PREMULTIPLIED,rendered.data(),rendered.size());int output_width=0,output_height=0;auto png=image->GetAsPNG(1.f,true,output_width,output_height);auto result=CefDictionaryValue::Create();if(png){std::vector<unsigned char>bytes(png->GetSize());png->GetData(bytes.data(),bytes.size(),0);result->SetString("png",CefBase64Encode(bytes.data(),bytes.size()));}
    if(has_popup){auto popup=CefDictionaryValue::Create(),bounds=CefDictionaryValue::Create();bounds->SetInt("x",popup_rect_.x);bounds->SetInt("y",popup_rect_.y);bounds->SetInt("width",popup_rect_.width);bounds->SetInt("height",popup_rect_.height);popup->SetDictionary("bounds",bounds);popup->SetInt("frameSeq",popup_seq_);result->SetDictionary("popup",popup);}
    auto reply=CefDictionaryValue::Create();reply->SetInt("id",composition_id_);reply->SetDictionary("result",result);composition_id_=0;composition_pixels_.clear();auto value=CefValue::Create();value->SetDictionary(reply);const auto encoded=CefWriteJSON(value,JSON_WRITER_DEFAULT).ToString();OnDevToolsMessage(browser_,encoded.data(),encoded.size());
  }
  bool OnDevToolsMessage(CefRefPtr<CefBrowser>, const void* data, size_t size) override {
    auto message=Event("cdp");message->SetString("message",std::string(static_cast<const char*>(data),size));Emit(message);return true;
  }
  void Protocol(const std::string& command) {
    if (!browser_) return;
    auto value=CefParseJSON(command,JSON_PARSER_RFC); auto request=value ? value->GetDictionary() : nullptr;
    if (!request) return;
    const auto method=request->GetString("method").ToString();
    if(method=="Surface.composePopup"){
      const auto params=request->GetDictionary("params");if(!params)return;
      if(!popup_visible_){auto result=CefDictionaryValue::Create();result->SetString("png",params->GetString("png"));auto reply=CefDictionaryValue::Create();reply->SetInt("id",request->GetInt("id"));reply->SetDictionary("result",result);auto value=CefValue::Create();value->SetDictionary(reply);const auto encoded=CefWriteJSON(value,JSON_WRITER_DEFAULT).ToString();OnDevToolsMessage(browser_,encoded.data(),encoded.size());return;}
      auto bytes=CefBase64Decode(params->GetString("png"));if(!bytes)return;std::vector<unsigned char>raw(bytes->GetSize());bytes->GetData(raw.data(),raw.size(),0);auto image=CefImage::CreateImage();if(!image->AddPNG(1.f,raw.data(),raw.size()))return;auto bitmap=image->GetAsBitmap(1.f,CEF_COLOR_TYPE_BGRA_8888,CEF_ALPHA_TYPE_PREMULTIPLIED,composition_width_,composition_height_);if(!bitmap)return;composition_pixels_.resize(bitmap->GetSize());bitmap->GetData(composition_pixels_.data(),composition_pixels_.size(),0);composition_id_=request->GetInt("id");browser_->GetHost()->Invalidate(PET_POPUP);return;
    }
    if(method=="Surface.sendMouseEvent"){
      const auto params=request->GetDictionary("params");if(!params)return;CefMouseEvent event;event.x=params->GetInt("x");event.y=params->GetInt("y");event.modifiers=params->GetInt("modifiers");const auto type=params->GetString("type").ToString();const auto button=params->GetString("button").ToString();const auto button_type=button=="right"?MBT_RIGHT:button=="middle"?MBT_MIDDLE:MBT_LEFT;
      if(type=="move")browser_->GetHost()->SendMouseMoveEvent(event,false);else if(type=="wheel")browser_->GetHost()->SendMouseWheelEvent(event,params->GetInt("deltaX"),params->GetInt("deltaY"));else browser_->GetHost()->SendMouseClickEvent(event,button_type,type=="up",1);
      auto reply=CefDictionaryValue::Create();reply->SetInt("id",request->GetInt("id"));reply->SetDictionary("result",CefDictionaryValue::Create());auto value=CefValue::Create();value->SetDictionary(reply);const auto encoded=CefWriteJSON(value,JSON_WRITER_DEFAULT).ToString();OnDevToolsMessage(browser_,encoded.data(),encoded.size());return;
    }
    if(method=="Surface.sendKeyEvent"){
      const auto params=request->GetDictionary("params");if(!params)return;CefKeyEvent event;const auto type=params->GetString("type").ToString();event.type=type=="up"?KEYEVENT_KEYUP:type=="char"?KEYEVENT_CHAR:KEYEVENT_RAWKEYDOWN;event.modifiers=params->GetInt("modifiers");event.windows_key_code=params->GetInt("windowsKeyCode");event.native_key_code=params->GetInt("nativeKeyCode");event.character=params->GetInt("character");event.unmodified_character=params->GetInt("unmodifiedCharacter");browser_->GetHost()->SendKeyEvent(event);auto reply=CefDictionaryValue::Create();reply->SetInt("id",request->GetInt("id"));reply->SetDictionary("result",CefDictionaryValue::Create());auto value=CefValue::Create();value->SetDictionary(reply);const auto encoded=CefWriteJSON(value,JSON_WRITER_DEFAULT).ToString();OnDevToolsMessage(browser_,encoded.data(),encoded.size());return;
    }
    if(method=="Surface.focus"){
      browser_->GetHost()->SetFocus(true);auto reply=CefDictionaryValue::Create();reply->SetInt("id",request->GetInt("id"));reply->SetDictionary("result",CefDictionaryValue::Create());auto value=CefValue::Create();value->SetDictionary(reply);const auto encoded=CefWriteJSON(value,JSON_WRITER_DEFAULT).ToString();OnDevToolsMessage(browser_,encoded.data(),encoded.size());return;
    }
    if(method=="Surface.instrumentation"){
      auto result=CefDictionaryValue::Create();
#if defined(ACANVAS_TEST_CLIPBOARD_TRIPWIRE)
      result->SetBool("clipboardTripwire",true);result->SetInt("pasteboardCalls",pasteboard_calls.load());result->SetInt("pasteboardReads",pasteboard_reads.load());result->SetInt("pasteboardWrites",pasteboard_writes.load());
      result->SetInt("nameReads",pasteboard_names.load());result->SetInt("changeCountReads",pasteboard_sequences.load());result->SetInt("accessBehaviorReads",pasteboard_access_policy.load());
      result->SetInt("namedFactories",named_pasteboard_factories.load());result->SetInt("findFactories",find_pasteboard_factories.load());result->SetInt("findReads",find_pasteboard_reads.load());result->SetInt("findWrites",find_pasteboard_writes.load());
      result->SetInt("hostFindPreEvents",host_find_pre_events.load());result->SetInt("hostFindPostEvents",host_find_post_events.load());
      {std::lock_guard<std::mutex>lock(tripwire_mutex);auto stacks=CefListValue::Create();stacks->SetSize(pasteboard_stacks.size());for(size_t i=0;i<pasteboard_stacks.size();i++)stacks->SetString(i,pasteboard_stacks[i]);result->SetList("factoryBacktraces",stacks);}
      {std::lock_guard<std::mutex>lock(tripwire_mutex);auto selectors=CefDictionaryValue::Create();for(const auto&entry:unknown_pasteboard_selectors)selectors->SetInt(entry.first,entry.second);result->SetDictionary("unknownSelectors",selectors);}
      {std::lock_guard<std::mutex>lock(tripwire_mutex);auto types=CefDictionaryValue::Create();for(const auto&entry:unknown_pasteboard_types)types->SetString(entry.first,entry.second);result->SetDictionary("unknownSelectorTypes",types);}
      {std::lock_guard<std::mutex>lock(tripwire_mutex);auto stacks=CefListValue::Create();stacks->SetSize(unknown_pasteboard_stacks.size());for(size_t i=0;i<unknown_pasteboard_stacks.size();i++)stacks->SetString(i,unknown_pasteboard_stacks[i]);result->SetList("unknownSelectorBacktraces",stacks);}
#else
      result->SetBool("clipboardTripwire",false);
#endif
      auto reply=CefDictionaryValue::Create();reply->SetInt("id",request->GetInt("id"));reply->SetDictionary("result",result);auto value=CefValue::Create();value->SetDictionary(reply);const auto encoded=CefWriteJSON(value,JSON_WRITER_DEFAULT).ToString();OnDevToolsMessage(browser_,encoded.data(),encoded.size());return;
    }
    if(method=="Surface.resize"){
      const auto params=request->GetDictionary("params");if(!params)return;
      width_=params->GetInt("width");height_=params->GetInt("height");browser_->GetHost()->WasResized();
      auto reply=CefDictionaryValue::Create();reply->SetInt("id",request->GetInt("id"));reply->SetDictionary("result",CefDictionaryValue::Create());auto replyValue=CefValue::Create();replyValue->SetDictionary(reply);const auto encoded=CefWriteJSON(replyValue,JSON_WRITER_DEFAULT).ToString();OnDevToolsMessage(browser_,encoded.data(),encoded.size());return;
    }
    if (method=="Surface.sample") {
      if (pixels_.empty()) return;
      auto rendered=pixels_;
      if(popup_visible_&&!popup_pixels_.empty()){
        const int left=static_cast<int>(popup_rect_.x*scale_),top=static_cast<int>(popup_rect_.y*scale_);
        for(int y=0;y<popup_height_;++y)for(int x=0;x<popup_width_;++x){const int dx=left+x,dy=top+y;if(dx<0||dy<0||dx>=pixel_width_||dy>=pixel_height_)continue;const int source=(y*popup_width_+x)*4,target=(dy*pixel_width_+dx)*4,alpha=popup_pixels_[source+3];for(int c=0;c<3;c++)rendered[target+c]=popup_pixels_[source+c]+rendered[target+c]*(255-alpha)/255;rendered[target+3]=alpha+rendered[target+3]*(255-alpha)/255;}
      }
      auto image=CefImage::CreateImage();
      image->AddBitmap(1.f,pixel_width_,pixel_height_,CEF_COLOR_TYPE_BGRA_8888,CEF_ALPHA_TYPE_PREMULTIPLIED,rendered.data(),rendered.size());
      int width=0,height=0; auto png=image->GetAsPNG(1.f,true,width,height);
      if (!png) return;
      std::vector<unsigned char> bytes(png->GetSize());png->GetData(bytes.data(),bytes.size(),0);
      auto result=CefDictionaryValue::Create();result->SetString("png",CefBase64Encode(bytes.data(),bytes.size()));result->SetInt("width",width);result->SetInt("height",height);result->SetInt("nativeFrameSeq",paint_seq_);
      auto reply=CefDictionaryValue::Create();reply->SetInt("id",request->GetInt("id"));reply->SetDictionary("result",result);
      auto replyValue=CefValue::Create();replyValue->SetDictionary(reply);
      const auto encoded=CefWriteJSON(replyValue,JSON_WRITER_DEFAULT).ToString();OnDevToolsMessage(browser_,encoded.data(),encoded.size());return;
    }
    browser_->GetHost()->SendDevToolsMessage(command.data(),command.size());
  }
 private:
  int width_, height_, paint_seq_ = 0, channels_ = 0, sample_rate_ = 0;
  CefRefPtr<CefBrowser> browser_;
  CefRefPtr<CefRegistration> observer_;
  int pixel_width_=0,pixel_height_=0;
  std::vector<unsigned char> pixels_;
  double scale_;bool popup_visible_=false;CefRect popup_rect_;int popup_width_=0,popup_height_=0;std::vector<unsigned char> popup_pixels_;
  int popup_seq_=0,composition_id_=0,composition_width_=0,composition_height_=0;std::vector<unsigned char>composition_pixels_;
  IMPLEMENT_REFCOUNTING(SurfaceHandler);
};

class CloseTask : public CefTask {
 public:
  explicit CloseTask(CefRefPtr<SurfaceHandler> handler) : handler_(handler) {}
  void Execute() override { handler_->Close(); }
 private:
  CefRefPtr<SurfaceHandler> handler_;
  IMPLEMENT_REFCOUNTING(CloseTask);
};
class ProtocolTask : public CefTask {
 public:
  ProtocolTask(CefRefPtr<SurfaceHandler> handler,const std::string& command) : handler_(handler),command_(command) {}
  void Execute() override { handler_->Protocol(command_); }
 private:
  CefRefPtr<SurfaceHandler> handler_;std::string command_;
  IMPLEMENT_REFCOUNTING(ProtocolTask);
};
class SurfaceApp : public CefApp, public CefBrowserProcessHandler {
 public:
  SurfaceApp(const std::string& url, int width, int height,double scale) : url_(url), width_(width), height_(height),scale_(scale) {}
  CefRefPtr<CefBrowserProcessHandler> GetBrowserProcessHandler() override { return this; }
  void OnBeforeCommandLineProcessing(const CefString&, CefRefPtr<CefCommandLine> command) override {
    const auto disabled=command->GetSwitchValue("disable-features").ToString();
    command->RemoveSwitch("disable-features");
    command->AppendSwitchWithValue("disable-features", disabled.empty() ? "UseKeychainKeyProvider" : disabled+",UseKeychainKeyProvider");
    command->AppendSwitch("disable-background-networking");
    command->AppendSwitch("disable-component-update");
    command->AppendSwitch("enable-automation");
    command->AppendSwitch("disable-threaded-animation");
    command->AppendSwitchWithValue("headless","new");
  }
  void OnContextInitialized() override {
    CefWindowInfo window; window.SetAsWindowless(nullptr);
    CefBrowserSettings settings; settings.windowless_frame_rate = 30;
    settings.javascript_access_clipboard=STATE_DISABLED;settings.javascript_dom_paste=STATE_DISABLED;
    auto handler = CefRefPtr<SurfaceHandler>(new SurfaceHandler(width_, height_,scale_));
    CefBrowserHost::CreateBrowser(window, handler, url_, settings, nullptr, nullptr);
    std::thread([handler] { std::string line; while (std::getline(std::cin, line)) { if (line == "quit") break; if(line.size()<16*1024*1024)CefPostTask(TID_UI,new ProtocolTask(handler,line)); } CefPostTask(TID_UI, new CloseTask(handler)); }).detach();
  }
 private:
  std::string url_; int width_, height_;double scale_;
  IMPLEMENT_REFCOUNTING(SurfaceApp);
};

@interface SurfaceApplication : NSApplication <CefAppProtocol> { BOOL handling_; }
@end
@implementation SurfaceApplication
- (BOOL)isHandlingSendEvent { return handling_; }
- (void)setHandlingSendEvent:(BOOL)value { handling_ = value; }
- (void)sendEvent:(NSEvent*)event { CefScopedSendingEvent scope; [super sendEvent:event]; }
@end

int main(int argc, char* argv[]) {
#if defined(ACANVAS_TEST_CLIPBOARD_TRIPWIRE)
  InstallClipboardTripwire();
#endif
  CefScopedLibraryLoader library;
  if (!library.LoadInMain()) return 1;
#if defined(ACANVAS_TEST_CLIPBOARD_TRIPWIRE)
  InstallFindTripwire();
#endif
  CefMainArgs arguments(argc, argv);
  @autoreleasepool {
    [SurfaceApplication sharedApplication]; [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    auto command = CefCommandLine::CreateCommandLine(); command->InitFromArgv(argc, argv);
    const std::string url = command->GetSwitchValue("surface-url").ToString();
    if (url.rfind("http://127.0.0.1:", 0) != 0) return 2;
    CefSettings settings; settings.windowless_rendering_enabled = true; settings.no_sandbox = false;
    settings.command_line_args_disabled = true;
    settings.persist_session_cookies = false;
    CefString(&settings.cache_path) = "";
    CefString(&settings.root_cache_path) = command->GetSwitchValue("surface-cache");
    CefString(&settings.log_file) = command->GetSwitchValue("surface-log");
    const auto width=command->HasSwitch("surface-width") ? std::stoi(command->GetSwitchValue("surface-width").ToString()) : 480;
    const auto height=command->HasSwitch("surface-height") ? std::stoi(command->GetSwitchValue("surface-height").ToString()) : 260;
    const auto scale=command->HasSwitch("surface-scale") ? std::stod(command->GetSwitchValue("surface-scale").ToString()) : 1.;
    auto app = CefRefPtr<SurfaceApp>(new SurfaceApp(url, width, height,scale));
    if (!CefInitialize(arguments, settings, app, nullptr)) return CefGetExitCode();
    CefRunMessageLoop(); CefShutdown();
  }
  return 0;
}
