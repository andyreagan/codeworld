      * Shared abend handling: every batch program copies this in.
       9000-ABEND.
           DISPLAY 'ABENDING: ' ERROR-REC
           CALL 'CEE3ABD' USING 4095 1.
