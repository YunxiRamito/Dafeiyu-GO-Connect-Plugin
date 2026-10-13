import { ConnectionPluginError,                } from './errors.js'

                                  
                                      
                           
                         
                                                                                     
                                                                
                                                                                                                                               
                                                                                                                                  
                 
                           
                          
                               
                            
                     
                               
                                                                               
                         
                              
                                        
                                   
                              
                                
                             
                               
   
 

                                                                                   
                                                   

                                                                                                                                   
                                         
                                                                                                        
                                                                                                                             
 
                                                                                                                                                  
                                                                                                                                                  

                                    
                  
                    
                           
                                                                                                                                                                        
                                                                                                                                 
                                                                        
                                                                                                                                         
                                                                     
                                                                   
                                                                               
                                                                                                               
                                  
 
                                  
                    
                  
                                                            
                  
 
                                                                        
                                    
                  
                    
                           
                                                     
              
                                  
                      
                                                                                               
                         
 
                                                                                                                            

                                     
                                                                                                                        
                                                                                    
                                                                                                                                                                                                 
                                                                                                                                                                                                                 
                                                                                                                                         
                                                                                                                                                                                                                                                                                        
                                                                                                                                                                                                                                                               
                                                                                                                                                                                         
                                                                                                                                                                                                                              
                                                                                                                                                                                                              
                                                                                                                                                
                                                                                                                                      
                                                                                                                                                                                
                                                                                                                             
                                                                                                                                                                                                                                                  
                                                                                                                                                      
                                                                                                                        
 

                                                                        
                                               
                                                                                                         
 

export class UnavailableConnectionProvider                                       {
           protocol = 'dafeiyu-go.connection.v1'         
           transport = 'launcher_rpc'         
  #listeners = new Set                                  ()

  async get_connection_state()                                           {
    throw new ConnectionPluginError('launcher_unavailable', '启动器连接接口尚未提供。')
  }

  subscribe_connection_state(listener                                  )             {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async send_encrypted_message()                 { throw new ConnectionPluginError('launcher_unavailable', '启动器连接接口尚未提供。') }
  async list_incoming_messages()                 { throw new ConnectionPluginError('launcher_unavailable', '启动器连接接口尚未提供。') }
  async acknowledge_message()                 { throw new ConnectionPluginError('launcher_unavailable', '启动器连接接口尚未提供。') }
  async create_file_transfer()                 { throw new ConnectionPluginError('launcher_unavailable', '启动器连接接口尚未提供。') }
  async upload_file_chunk()                 { throw new ConnectionPluginError('launcher_unavailable', '启动器连接接口尚未提供。') }
  async complete_file_transfer()                 { throw new ConnectionPluginError('launcher_unavailable', '启动器连接接口尚未提供。') }
  async list_incoming_file_transfers()                 { throw new ConnectionPluginError('launcher_unavailable', '启动器连接接口尚未提供。') }
  async download_file_chunk()                 { throw new ConnectionPluginError('launcher_unavailable', '启动器连接接口尚未提供。') }
  async acknowledge_file_transfer()                 { throw new ConnectionPluginError('launcher_unavailable', '启动器连接接口尚未提供。') }
  async get_group_file_cache_stats()                 { throw new ConnectionPluginError('launcher_unavailable', '启动器连接接口尚未提供。') }
  async cleanup_group_file_cache()                 { throw new ConnectionPluginError('launcher_unavailable', '启动器连接接口尚未提供。') }
  async submit_remote_task()                 { throw new ConnectionPluginError('launcher_unavailable', '启动器连接接口尚未提供。') }
  async poll_remote_events()                 { throw new ConnectionPluginError('launcher_unavailable', '启动器连接接口尚未提供。') }
  async cancel_remote_task()                 { throw new ConnectionPluginError('launcher_unavailable', '启动器连接接口尚未提供。') }
  async remote_http()                 { throw new ConnectionPluginError('launcher_unavailable', '启动器连接接口尚未提供。') }
}

export class MockConnectionProvider                                       {
           protocol = 'dafeiyu-go.connection.v1'         
           transport = 'mock'         
           calls                                            = []
  #state                 
  #listeners = new Set                                  ()
  #messages                     = []

  constructor(state                           ) {
    this.#state = {
      protocol: 'dafeiyu-go.connection.v1', server_connected: false, group_id: null, pairing_status: 'unknown',
      local_device: { id: '', name: '', public_key: '' }, remote_device: null,
      capabilities: { workspace_sync: false, web_broadcast: false, encrypted_messages: false, encrypted_files: false, presence: false, file_cache_cleanup: false },
      ...state,
    }
  }

  setState(state                 )       { this.#state = state; for (const listener of this.#listeners) listener(state) }
  enqueueMessage(message                  )       { this.#messages.push(message) }
  async get_connection_state()                                           { this.calls.push({ method: 'get_connection_state', input: null }); return { success: true, request_id: crypto.randomUUID(), data: this.#state } }
  subscribe_connection_state(listener                                  )             { this.#listeners.add(listener); return () => this.#listeners.delete(listener) }
  async send_encrypted_message(input                                                   )                                                  { this.calls.push({ method: 'send_encrypted_message', input }); return { success: true, request_id: crypto.randomUUID(), data: { message_id: crypto.randomUUID() } } }
  async list_incoming_messages(input                                                       )                                                                                        { this.calls.push({ method: 'list_incoming_messages', input }); return { success: true, request_id: crypto.randomUUID(), data: { messages: this.#messages.splice(0, input.limit ?? 100), next_cursor: null } } }
  async acknowledge_message(input                                          )                                { this.calls.push({ method: 'acknowledge_message', input }); return { success: true, request_id: crypto.randomUUID(), data: null } }
  async create_file_transfer(input                                                                                       )                                                  { this.calls.push({ method: 'create_file_transfer', input }); return { success: true, request_id: crypto.randomUUID(), data: { transfer_id: 'transfer_mock', ...input } } }
  async upload_file_chunk(input                                                                                                                      )                                                 { this.calls.push({ method: 'upload_file_chunk', input: { ...input, bytes: `<${input.bytes.byteLength} bytes>` } }); return { success: true, request_id: crypto.randomUUID(), data: { accepted: true } } }
  async complete_file_transfer(input                                           )                                                  { this.calls.push({ method: 'complete_file_transfer', input }); return { success: true, request_id: crypto.randomUUID(), data: { completed: true } } }
  async list_incoming_file_transfers(input                                                       )                                                                                               { this.calls.push({ method: 'list_incoming_file_transfers', input }); return { success: true, request_id: crypto.randomUUID(), data: { transfers: [], next_cursor: null } } }
  async download_file_chunk(input                                                                )                                                                               { this.calls.push({ method: 'download_file_chunk', input }); return { success: true, request_id: crypto.randomUUID(), data: { bytes: new Uint8Array(), hash: '', final: true } } }
  async acknowledge_file_transfer(input                                           )                                { this.calls.push({ method: 'acknowledge_file_transfer', input }); return { success: true, request_id: crypto.randomUUID(), data: null } }
  async get_group_file_cache_stats(input                      )                                          { this.calls.push({ method: 'get_group_file_cache_stats', input }); return { success: true, request_id: crypto.randomUUID(), data: { uploading: 0, available: 0, cleanup_pending: 0, logical_deleted: 0, physical_bytes: 0 } } }
  async cleanup_group_file_cache(input                                                                   )                                         { this.calls.push({ method: 'cleanup_group_file_cache', input }); return { success: true, request_id: crypto.randomUUID(), data: { group_id: input.group_id, batch_id: input.idempotency_key, logical_deleted: input.file_ids.length, physical_deleted: input.file_ids.length, pending_physical: 0 } } }
  async submit_remote_task(input                   )                                            { this.calls.push({ method: 'submit_remote_task', input }); return { success: true, request_id: crypto.randomUUID(), data: { request_id: input.request_id, accepted: true } } }
  async poll_remote_events(input                                                                                   )                                                                                                 { this.calls.push({ method: 'poll_remote_events', input }); return { success: true, request_id: crypto.randomUUID(), data: { events: [], next_sequence: input.after_sequence ?? 0, closed: false } } }
  async cancel_remote_task(input                                          )                                              { this.calls.push({ method: 'cancel_remote_task', input }); return { success: true, request_id: crypto.randomUUID(), data: { accepted: true } } }
  async remote_http(input                   )                                              { this.calls.push({ method: 'remote_http', input }); return { success: true, request_id: crypto.randomUUID(), data: { request_id: input.request_id, events: [], next_sequence: 0, final: true } } }
}
