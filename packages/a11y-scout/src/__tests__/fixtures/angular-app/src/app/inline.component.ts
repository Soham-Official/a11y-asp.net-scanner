import { Component } from '@angular/core';

@Component({
  selector: 'app-inline',
  // Missing label association (3.3.2/4.1.2)
  template: '<input id="x"><label>Name</label>',
  styleUrls: []
})
export class InlineComponent {
}
