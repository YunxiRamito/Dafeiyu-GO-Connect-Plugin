import { ConnectionPluginError,                } from './errors.js'

                                           
                                      
                    
                
           
 
                                                                             
                                                                                                                               
                                                       
                                                                                                                                                    

export function makeRequestId()         { return crypto.randomUUID() }

export class ConnectionIpcClient {
                   transport              
                   defaultTimeoutMs        
  constructor(transport              , defaultTimeoutMs = 20_000) { this.transport = transport; this.defaultTimeoutMs = defaultTimeoutMs }

  async call   (method        , params         , options                                               = {})             {
    const request_id = makeRequestId()
    if (options.signal?.aborted) throw new ConnectionPluginError('request_cancelled', 'IPC 请求已取消。', { requestId: request_id })
    const response = await this.transport.request   ({ protocol: 'dafeiyu-go.connection.v1', request_id, method, params }, { ...options, timeoutMs: options.timeoutMs ?? this.defaultTimeoutMs })
    if (!response.success) throw new ConnectionPluginError(response.error_code, response.message, { requestId: response.request_id || request_id, retryable: response.retryable })
    return response.data
  }
}
