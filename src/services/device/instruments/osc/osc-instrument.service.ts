import { Injectable } from '@angular/core';
import { Observable } from 'rxjs/Observable';
import 'rxjs/Rx';

//Services
import { GenericInstrumentService } from '../generic-instrument.service';
import { OscChannelService } from './osc-channel.service';
import { WaveformService } from '../../../data-types/waveform.service';

//Services
import { TransportContainerService } from '../../../transport/transport-container.service';
import { CommandUtilityService } from '../../../utilities/command-utility.service';

@Injectable()
export class OscInstrumentService extends GenericInstrumentService {

    readonly numChans: number;
    readonly chans: OscChannelService[] = [];

    readonly numDataBuffers = 8;
    readonly dataBuffer: Array<Array<WaveformService>> = [];
    private dataBufferWriteIndex: number = 0;
    public dataBufferReadIndex: number = 0;
    private commandUtilityService: CommandUtilityService;
    public rawPacket: ArrayBuffer;

    constructor(_transport: TransportContainerService, _oscInstrumentDescriptor: any) {
        super(_transport, '/');

        //Populate DC supply parameters
        this.numChans = _oscInstrumentDescriptor.numChans;
        this.commandUtilityService = new CommandUtilityService();

        //Populate channels        
        for (let channel in _oscInstrumentDescriptor) {
            if (channel !== 'numChans') {
                this.chans.push(new OscChannelService(_oscInstrumentDescriptor[channel]));
            }
        }
        for (let i = 0; i < this.numDataBuffers; i++) {
            this.dataBuffer.push([]);
        }
    }

    getCurrentState(chans: number[]) {
        let command = this.getCurrentStateJson(chans);
        return super._genericResponseHandler(command);
    }

    getCurrentStateJson(chans: number[]) {
        let command = {
            osc: {}
        };
        chans.forEach((element, index, array) => {
            command.osc[chans[index]] =
                [
                    {
                        command: 'getCurrentState'
                    }
                ]
        });
        return command;
    }

    getCurrentStateParse(chan, responseObject) {
        return 'Success';
    }

    setParametersJson(chans: number[], offsets: number[], gains: number[], sampleFreqs: number[], bufferSizes: number[], delays: number[]) {
        let command = {
            "osc": {}
        }
        chans.forEach((element, index, array) => {
            command.osc[chans[index]] =
                [
                    {
                        command: "setParameters",
                        vOffset: Math.round(offsets[index] * 1000),
                        gain: gains[index],
                        sampleFreq: Math.round(sampleFreqs[index] * 1000),
                        bufferSize: Math.round(bufferSizes[index]),
                        triggerDelay: Math.round(delays[index] * 1000000000000)
                    }
                ]
        });
        return command;
    }

    setParametersParse(chan, responseObject) {
        return 'Channel ' + chan + ' ' + responseObject.command + ' successful';
    }

    //Tell OpenScope to run once and return a buffer
    setParameters(chans: number[], offsets: number[], gains: number[], sampleFreqs: number[], bufferSizes: number[], delays: number[]): Observable<any> {
        if (chans.length == 0) {
            return Observable.create((observer) => {
                observer.complete();
            });
        }

        let command = this.setParametersJson(chans, offsets, gains, sampleFreqs, bufferSizes, delays);
        return super._genericResponseHandler(command);
    }

    //Tell OpenScope to run once and return a buffer
    read(chans: number[]): Observable<any> {
        if (chans.length == 0) {
            return Observable.create((observer) => {
                observer.complete();
            });
        }

        let command = {
            "osc": {}
        }
        chans.forEach((element, index, array) => {
            command.osc[chans[index]] =
                [
                    {
                        "command": "read"
                    }
                ]
        });
        this.dataBuffer[this.dataBufferWriteIndex] = [];
        return Observable.create((observer) => {
            this.transport.writeRead('/', JSON.stringify(command), 'json').subscribe(
                (data) => {
                    this.rawPacket = data;
                    this.commandUtilityService.observableParseChunkedTransfer(data).subscribe(
                        (data) => {
                            let command = data.json;
                            console.log(command);
                            for (let channel in command.osc) {
                                if (command.osc[channel][0].statusCode > 0) {
                                    observer.error('One or more channels still acquiring');
                                    return;
                                }
                                let binaryOffset = command.osc[channel][0].binaryOffset / 2;
                                let binaryData = data.typedArray.slice(binaryOffset, binaryOffset + command.osc[channel][0].binaryLength / 2);
                                let untypedArray = Array.prototype.slice.call(binaryData);
                                let scaledArray = untypedArray.map((voltage) => {
                                    return voltage / 1000;
                                });
                                let dt = 1 / (command.osc[channel][0].actualSampleFreq / 1000);
                                let pointContainer = [];
                                let triggerPosition = -1 * command.osc[channel][0].triggerDelay / Math.pow(10, 12) + dt * scaledArray.length / 2;
                                for (let i = 0; i < scaledArray.length; i++) {
                                    pointContainer.push([i * dt - triggerPosition, scaledArray[i]]);
                                }
                                this.dataBuffer[this.dataBufferWriteIndex][parseInt(channel) - 1] = new WaveformService({
                                    dt: 1 / (command.osc[channel][0].actualSampleFreq / 1000),
                                    t0: 0,
                                    y: scaledArray,
                                    data: pointContainer,
                                    pointOfInterest: command.osc[channel][0].pointOfInterest,
                                    triggerPosition: command.osc[channel][0].triggerIndex,
                                    seriesOffset: command.osc[channel][0].actualVOffset / 1000,
                                    triggerDelay: (command.osc[channel][0].triggerDelay == undefined ? command.osc[channel][0].actualTriggerDelay : command.osc[channel][0].triggerDelay)
                                });
                            }
                            this.dataBufferReadIndex = this.dataBufferWriteIndex;
                            this.dataBufferWriteIndex = (this.dataBufferWriteIndex + 1) % this.numDataBuffers;
                            let finish = performance.now();
                            observer.next(command);
                            //Handle device errors and warnings
                            observer.complete();
                        },
                        (err) => {
                            observer.error(data);
                        },
                        () => { }
                    );
                },
                (err) => {
                    observer.error(err);
                },
                () => { }
            )
        });
    }

}